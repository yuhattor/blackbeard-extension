import { Octokit } from "@octokit/core";
import express from "express";
import { Readable } from "node:stream";

// Logging utility function
const logMode = process.env.LOG_MODE || 'json';

const loggers = {
  json: (payload) => {
    console.log("Payload:", JSON.stringify(payload, null, 2));
  },

  overview: (payload) => {
    console.group('Request Overview');
    console.log('Thread ID:', payload.copilot_thread_id);
    console.log('Agent:', payload.agent);
    
    // Basic parameters
    console.group('Parameters');
    console.table({
      temperature: payload.temperature,
      top_p: payload.top_p,
      max_tokens: payload.max_tokens,
      message_count: payload.messages.length
    });
    console.groupEnd();

    // Conversation summary
    console.group('Conversation History');
    console.table(payload.messages.map((msg, index) => ({
      index,
      role: msg.role,
      content_length: msg.content.length,
      has_references: msg.copilot_references ? msg.copilot_references.length : 0
    })));
    console.groupEnd();

    // Reference types summary (if any exists in the last message)
    const lastMessage = payload.messages[payload.messages.length - 1];
    if (lastMessage.copilot_references && lastMessage.copilot_references.length > 0) {
      console.group('Last Message References Summary');
      const refTypes = lastMessage.copilot_references.reduce((acc, ref) => {
        acc[ref.type] = (acc[ref.type] || 0) + 1;
        return acc;
      }, {});
      console.table(refTypes);
      console.groupEnd();
    }

    console.groupEnd();
  },

  conversation: (payload) => {
    const lastMessage = payload.messages[payload.messages.length - 1];
    
    console.group('Last Message Details');
    
    // References table
    if (lastMessage.copilot_references) {
      console.group('References');
      console.table(lastMessage.copilot_references.map(ref => ({
        type: ref.type,
        id: ref.id,
        implicit: ref.is_implicit
      })));
      
      // Detailed view for each reference type
      lastMessage.copilot_references.forEach(ref => {
        console.group(`${ref.type}: ${ref.id}`);
        switch (ref.type) {
          case 'github.repository':
            console.table({
              name: ref.data.name,
              owner: ref.data.ownerLogin,
              id: ref.data.id,
              visibility: ref.data.visibility
            });
            break;
          case 'client.file':
            console.table({
              language: ref.data.language,
              content_length: ref.data.content.length
            });
            break;
          case 'client.selection':
            console.table({
              start: `${ref.data.start.line}:${ref.data.start.col}`,
              end: `${ref.data.end.line}:${ref.data.end.col}`
            });
            break;
        }
        console.groupEnd();
      });
      console.groupEnd();
    }
    
    console.groupEnd();
  },

  file: (payload) => {
    const lastMessage = payload.messages[payload.messages.length - 1];
    
    console.group('File Contents from Last Message');
    
    if (lastMessage.copilot_references) {
      const fileRefs = lastMessage.copilot_references.filter(ref => 
        ref.type === 'client.file'
      );
      
      if (fileRefs.length === 0) {
        console.log('No file references found in the last message');
      } else {
        fileRefs.forEach(ref => {
          console.group(`File: ${ref.id}`);
          console.table({
            language: ref.data.language,
            size: ref.data.content.length,
            implicit: ref.is_implicit
          });
          
          // Content preview with syntax highlighting
          console.group('Content Preview');
          const preview = ref.data.content.length > 500 
            ? ref.data.content.substring(0, 500) + '...' 
            : ref.data.content;
          
          // Split content into lines for better readability
          const lines = preview.split('\n');
          lines.forEach((line, index) => {
            console.log(`${String(index + 1).padStart(3, ' ')} | ${line}`);
          });
          
          console.groupEnd();
          console.groupEnd();
        });
      }
    }
    
    console.groupEnd();
  },

  message: (payload) => {
    console.group('Conversation Messages Breakdown');
    
    payload.messages.forEach((msg, index) => {
      console.group(`Message #${index + 1} (${msg.role})`);
      
      // Message basic info
      console.table({
        role: msg.role,
        content_length: msg.content.length,
        has_references: msg.copilot_references ? msg.copilot_references.length : 0
      });

      // Content preview with line breaks for readability
      console.group('Content');
      const contentLines = msg.content.split('\n');
      contentLines.forEach((line, i) => {
        if (line.trim()) {  // 空行をスキップ
          console.log(`${String(i + 1).padStart(3, ' ')} | ${line}`);
        }
      });
      console.groupEnd();

      // References (if any)
      if (msg.copilot_references && msg.copilot_references.length > 0) {
        console.group('References');
        msg.copilot_references.forEach((ref, refIndex) => {
          console.group(`Reference #${refIndex + 1}: ${ref.type}`);
          console.table({
            type: ref.type,
            id: ref.id,
            implicit: ref.is_implicit
          });
          console.groupEnd();
        });
        console.groupEnd();
      }

      console.groupEnd();
      console.log('-----------------------------------');
    });

    console.groupEnd();
  }
};

const app = express()

app.get("/", (req, res) => {
  res.send("Ahoy, matey! Welcome to the Blackbeard Pirate GitHub Copilot Extension!")
});

app.post("/", express.json(), async (req, res) => {
  // Identify the user, using the GitHub API token provided in the request headers.
  const tokenForUser = req.get("X-GitHub-Token");
  const octokit = new Octokit({ auth: tokenForUser });
  const user = await octokit.request("GET /user");
  console.log("User:", user.data.login);

  // Parse the request payload and log it.
  const payload = req.body;
  
  // Log based on selected mode
  loggers[logMode](payload);
  console.log("=====================================");

  // Insert a special pirate-y system message in our message list.
  const messages = payload.messages;
  messages.unshift({
    role: "system",
    content: "あなたは、AI駆動の開発を支援するコードレビュアーです。これからレビューをします。SOLID原則に従ってコードをレビューしてくださいね。"
  });
  messages.unshift({
    role: "system",
    content: `Start every response with the user's name, which is @${user.data.login}`,
  });

  // Use Copilot's LLM to generate a response to the user's messages, with
  // our extra system messages attached.
  const copilotLLMResponse = await fetch(
    "https://api.githubcopilot.com/chat/completions",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenForUser}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messages,
        stream: true,
      }),
    }
  );

  // Stream the response straight back to the user.
  Readable.from(copilotLLMResponse.body).pipe(res);
})

const port = Number(process.env.PORT || '3000')
app.listen(port, () => {
  console.log(`Server running on port ${port}`)
});