require("dotenv").config();
const express = require("express");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const app = express();
const port = 3001;
const cors = require("cors");
const { ClerkExpressRequireAuth } = require("@clerk/clerk-sdk-node");
const mysql = require("mysql2");
const Stripe = require("stripe");
const axios = require("axios");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.use(cors());

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});
// For development test connection on startup
pool.getConnection((err, conn) => {
  if (err) {
    console.error("MySQL pool connection error:", err);
  } else {
    console.log("MySQL pool is ready");
    conn.release();
  }
});

app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body, // raw buffer
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = await stripe.checkout.sessions.retrieve(
        event.data.object.id,
        {
          expand: ["subscription", "line_items.data.price"],
        }
      );

      const userId = session.client_reference_id;
      const priceId = session.line_items.data[0].price.id;
      const subscriptionId = session.subscription.id;

      let plan = "none";
      if (priceId === process.env.STRIPE_PRICE_ANNUAL_ID) {
        plan = "annual";
      } else if (priceId === process.env.STRIPE_PRICE_MONTHLY_ID) {
        plan = "monthly";
      }

      // Update the user's credits in your database
      pool.query(
        `UPDATE user_credits
           SET credits = credits + 50,
               subscription_status = ?,
               subscription_id = ?
         WHERE user_id = ?`,
        [plan, subscriptionId, userId],
        (err, results) => {
          if (err) {
            console.error("Error updating credits via webhook:", err);
          } else {
            console.log(
              `User ${userId}: +50 credits, plan set to ${plan}, sub ID: ${subscriptionId}`
            );
          }
        }
      );
    }

    if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object;
      const subscriptionId = subscription.id;

      // clear status & id for any user with this sub
      pool.query(
        `UPDATE user_credits
        SET subscription_status = 'none',
            subscription_id = NULL
      WHERE subscription_id = ?`,
        [subscriptionId],
        (err) => {
          if (err) console.error("Error clearing cancelled sub:", err);
          else console.log(`Cleared cancelled subscription ${subscriptionId}`);
        }
      );
    }

    res.json({ received: true });
  }
);

app.use(express.json());

app.post(
  "/create-checkout-session",
  ClerkExpressRequireAuth(),
  async (req, res) => {
    const { userId } = req.auth;
    // Expect the client to send which plan the user wants ("monthly" or "annual")
    const { plan } = req.body;

    try {
      const priceId =
        plan === "annual"
          ? process.env.STRIPE_PRICE_ANNUAL_ID
          : process.env.STRIPE_PRICE_MONTHLY_ID;

      // Create a Stripe Checkout Session for subscription
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        payment_method_types: ["card"],
        line_items: [
          {
            price: priceId,
            quantity: 1,
          },
        ],
        success_url: process.env.SUCCESS_URL,
        cancel_url: process.env.CANCEL_URL,
        client_reference_id: userId,
      });

      res.status(200).json({ sessionId: session.id });
    } catch (error) {
      console.error("Error creating checkout session:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

app.get("/credits", ClerkExpressRequireAuth(), (req, res) => {
  const { userId } = req.auth;
  pool.query(
    "SELECT credits FROM user_credits WHERE user_id = ?",
    [userId],
    (error, results) => {
      if (error) {
        console.error("Error fetching credits:", error);
        return res.status(500).json({ error: "Error fetching credits" });
      }
      // If no record exists, create one with 0 credits
      if (results.length === 0) {
        pool.query(
          "INSERT INTO user_credits (user_id, credits) VALUES (?, 0)",
          [userId],
          (insertError) => {
            if (insertError) {
              console.error("Error inserting new user credits:", insertError);
              return res
                .status(500)
                .json({ error: "Error creating credits record" });
            }
            return res.status(200).json({ credits: 0 });
          }
        );
      } else {
        const credits = results[0].credits;
        return res.status(200).json({ credits });
      }
    }
  );
});

app.get("/plan", ClerkExpressRequireAuth(), async (req, res) => {
  const { userId } = req.auth;

  try {
    const [[row]] = await pool
      .promise()
      .query(
        "SELECT subscription_status, subscription_id FROM user_credits WHERE user_id = ?",
        [userId]
      );

    // If no row yet, insert the defaults and return 'none'
    if (!row) {
      await pool
        .promise()
        .query("INSERT INTO user_credits (user_id, credits) VALUES (?, 0)", [
          userId,
        ]);
      return res.json({
        plan: "none",
        cancelled: false,
        cancelAtPeriodEnd: false,
        periodEnd: null,
      });
    }

    const plan = row.subscription_status; // "none"|"annual"|"monthly"
    const subscriptionId = row.subscription_id;

    let cancelled = false;
    let cancelAtPeriodEnd = false;
    let periodEnd = null;

    // If you have a Stripe subscription ID, fetch its real status
    if (subscriptionId) {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);

      cancelled = subscription.status === "canceled";
      cancelAtPeriodEnd = subscription.cancel_at_period_end;
      periodEnd = subscription.cancel_at; // UNIX timestamp
    }

    return res.json({
      plan,
      cancelled,
      cancelAtPeriodEnd,
      periodEnd,
    });
  } catch (err) {
    console.error("Error fetching plan info:", err);
    return res.status(500).json({ error: "Could not fetch subscription info" });
  }
});

app.post(
  "/cancel-subscription",
  ClerkExpressRequireAuth(),
  async (req, res) => {
    const { userId } = req.auth;

    try {
      // 1) Look up their Stripe subscription ID
      const [[row]] = await pool
        .promise()
        .query("SELECT subscription_id FROM user_credits WHERE user_id = ?", [
          userId,
        ]);

      if (!row || !row.subscription_id) {
        return res
          .status(400)
          .json({ error: "No active subscription to cancel." });
      }

      // 2) Only call Stripe to delete it—no DB update here
      await stripe.subscriptions.update(row.subscription_id, {
        cancel_at_period_end: true,
      });

      // 3) Respond immediately so the UI can reset if you want
      res.json({ success: true });
    } catch (err) {
      console.error("Error cancelling subscription:", err);
      res.status(500).json({ error: "Could not cancel subscription." });
    }
  }
);

let isGenerating = false;

app.post("/generate", ClerkExpressRequireAuth(), (req, res) => {
  if (isGenerating) {
    return res.status(429).json({
      error:
        "A video generation process is already in progress. Please try again later.",
    });
  }

  isGenerating = true; // Lock for this request

  const { userId } = req.auth;
  pool.query(
    "UPDATE user_credits SET credits = credits - 1 WHERE user_id = ? AND credits > 0",
    [userId],
    (updateError, updateResults) => {
      if (updateError) {
        console.error("Error decrementing credits:", updateError);
        isGenerating = false;
        return res.status(500).json({ error: "Error updating credits" });
      }
      // If no rows were updated, the user doesn't have enough credits.
      if (updateResults.affectedRows === 0) {
        isGenerating = false;
        return res.status(400).json({ error: "Not enough credits" });
      }

      console.log("Authenticated user:", req.auth);
      const responseList = req.body;
      const uniqueId = uuidv4();
      const pythonInterpreter = "./venv/bin/python";
      const pythonScript = "generate_video.py";
      const scriptDirectory = path.join(__dirname, "video_creation");

      // Spawn the Python process to generate the video
      const pythonProcess = spawn(pythonInterpreter, [pythonScript, uniqueId], {
        cwd: scriptDirectory,
      });

      // Write the JSON input to the Python process
      pythonProcess.stdin.write(JSON.stringify(responseList));
      pythonProcess.stdin.end();

      let pythonOutput = "";

      pythonProcess.stdout.on("data", (data) => {
        pythonOutput += data.toString();
        console.log(`Python stdout: ${data}`);
      });

      pythonProcess.stderr.on("data", (data) => {
        console.error(`Python stderr: ${data}`);
      });

      pythonProcess.on("close", (code) => {
        console.log(`Python script exited with code ${code}`);
        const outputFilePath = path.join(
          scriptDirectory,
          `output_info_${uniqueId}.json`
        );
        fs.readFile(outputFilePath, "utf8", (err, fileData) => {
          // Reset the lock no matter what happens
          isGenerating = false;

          if (err) {
            console.error("Error reading output file:", err);
            return res.status(500).send("Error reading output file");
          }
          try {
            const outputJson = JSON.parse(fileData);
            const filePath = outputJson.output_file;
            console.log("Parsed output file:", filePath);
            // Use res.download to send the file with a proper filename and extension
            res.download(filePath, "video.mp4", (err) => {
              if (err) {
                console.error("Error sending file:", err);
                res.status(500).send("Error sending file");
              }
            });
          } catch (parseErr) {
            console.error("Error parsing JSON:", parseErr);
            res.status(500).send("Error parsing output file");
          }
        });
      });

      pythonProcess.on("error", (err) => {
        console.error("Python process error:", err);
        isGenerating = false;
        return res.status(500).json({ error: "Error generating video" });
      });
    }
  );
});

app.get("/reddit-post-title", ClerkExpressRequireAuth(), async (req, res) => {
  const redditUrl = req.query.url;
  if (!redditUrl) {
    return res
      .status(400)
      .json({ error: "The 'url' query parameter is required." });
  }

  // Build the oEmbed URL this
  const oembedUrl =
    "https://www.reddit.com/oembed?url=" + encodeURIComponent(redditUrl);

  try {
    const response = await axios.get(oembedUrl, {
      headers: { "User-Agent": "MyRedditApp/1.0" },
      timeout: 10000,
    });
    // oEmbed payload includes "title"
    const title = response.data?.title;
    if (!title) {
      console.error(
        "[reddit-post‑title] no title in oEmbed response:",
        response.data
      );
      return res
        .status(404)
        .json({ error: "Could not extract title from oEmbed response." });
    }
    res.json({ title });
  } catch (err) {
    console.error(
      "[reddit-post‑title] oEmbed fetch error:",
      err.toJSON ? err.toJSON() : err
    );
    res.status(500).json({ error: "Error fetching Reddit post title" });
  }
});

app.get("/test", (req, res) => {
  console.log("Test reached");
  res.send("Test route is working!");
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Server running on http://0.0.0.0:${port}`);
});
