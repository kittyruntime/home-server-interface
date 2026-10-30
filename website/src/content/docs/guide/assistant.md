---
title: The built-in assistant
description: Chat with an AI that looks after the NAS from the dashboard, with the AI provider of your choice.
---

The **Assistant** app is a chat in the dashboard. Ask about the NAS in plain
language ("how much space is left?", "are all my apps running?", "clean up
the duplicates in my Downloads folder") and the assistant finds the answer with
the same tools as an [MCP assistant](/home-server-interface/guide/ai-assistant/):
files in Places, apps, storage, accounts, shares, backups, updates and the
audit log. It acts as the account that chats, never with more rights.

## Set it up

An administrator sets it up once, in **Settings > AI access** (or from the
Assistant app, the first time):

- **AI provider**: OpenRouter, OpenAI, Anthropic, Mistral AI, Ollama, or any
  other service that speaks the OpenAI-compatible Chat Completions API.
  OpenRouter gives access to most models with one key. Ollama runs a model on
  your own hardware, so nothing leaves your network.
- **API address**: filled in for each provider. For Ollama on the NAS itself,
  `http://127.0.0.1:11434/v1`.
- **API key**: the provider's key. It is encrypted on the server (with
  `HSI_SECRETS_KEY`) and never shown again; leave the field empty to keep it.
- **Model**: **Check** lists the provider's models. Choose one that can call
  tools: the assistant does nothing without them.
- **Who may use it**: administrators only (the default), or every account.

## Chat

Conversations are kept per account (the 50 latest) and can be deleted. While
the assistant works, each tool it calls shows under its answer. **Stop** ends
the answer at once.

Creating folders and files, renaming, moving and copying happen at once.
Deletions, file overwrites and every storage, app, account, share, permission
or update change wait for your approval: the request shows in the chat with
**Approve** and **Reject**, and the assistant goes on once you decided. The
same requests also show in the requests panel at the bottom right of the
dashboard.

## Privacy and safety

- What the assistant reads, such as file contents and logs, is sent to the AI
  provider. Choose a local model to keep it on your network.
- The assistant never goes beyond the rights of the account that chats, and it
  can neither change its own settings nor approve its own requests.
- File contents and logs are treated as data: the assistant is told never to
  follow instructions found in them, and what deletes or reconfigures waits for
  you anyway.
- Its actions are in the audit log (**Monitor > Audit log**), marked as the
  built-in assistant's, and can be shown alone.
