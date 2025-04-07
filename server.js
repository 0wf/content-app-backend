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

app.use(cors());

app.use(express.json());

const connection = mysql.createConnection({
  host: process.env.MYSQL_HOST, // e.g., "localhost"
  user: process.env.MYSQL_USER, // your MySQL username
  password: process.env.MYSQL_PASSWORD, // your MySQL password
  database: process.env.MYSQL_DATABASE, // the database name you created
});

// For development testingx
connection.connect((err) => {
  if (err) {
    console.error("Error connecting to MySQL:", err);
  } else {
    console.log("Connected to MySQL!");
  }
});

app.get("/credits", ClerkExpressRequireAuth(), (req, res) => {
  const { userId } = req.auth;
  connection.query(
    "SELECT credits FROM user_credits WHERE user_id = ?",
    [userId],
    (error, results) => {
      if (error) {
        console.error("Error fetching credits:", error);
        return res.status(500).json({ error: "Error fetching credits" });
      }
      // If no record exists, create one with 50 credits
      if (results.length === 0) {
        connection.query(
          "INSERT INTO user_credits (user_id, credits) VALUES (?, 50)",
          [userId],
          (insertError) => {
            if (insertError) {
              console.error("Error inserting new user credits:", insertError);
              return res
                .status(500)
                .json({ error: "Error creating credits record" });
            }
            return res.status(200).json({ credits: 50 });
          }
        );
      } else {
        const credits = results[0].credits;
        return res.status(200).json({ credits });
      }
    }
  );
});

app.post("/generate", ClerkExpressRequireAuth(), (req, res) => {
  const { userId } = req.auth;
  connection.query(
    "UPDATE user_credits SET credits = credits - 1 WHERE user_id = ? AND credits > 0",
    [userId],
    (updateError, updateResults) => {
      if (updateError) {
        console.error("Error decrementing credits:", updateError);
        return res.status(500).json({ error: "Error updating credits" });
      }
      // If no rows were updated, the user doesn't have enough credits.
      if (updateResults.affectedRows === 0) {
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
    }
  );
});

app.get("/test", (req, res) => {
  console.log("Test reached");
  res.send("Test route is working!");
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Server running on http://0.0.0.0:${port}`);
});
