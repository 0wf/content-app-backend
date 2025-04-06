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

app.use(cors());

app.use(express.json());

app.post("/generate", ClerkExpressRequireAuth(), (req, res) => {
  // For testing
  console.log("Authenticated user:", req.auth);
  const responseList = req.body;

  const uniqueId = uuidv4();

  const pythonScript = "generate_video.py";
  const scriptDirectory = path.join(__dirname, "video_creation");

  // Pass the uniqueId as an extra argument to the Python script
  const pythonProcess = spawn("python3", [pythonScript, uniqueId], {
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
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Server running on http://0.0.0.0:${port}`);
});
