# 🧠 Mnemosyne

> *Your notes shouldn't just sit there. They should teach you.*

**Mnemosyne** is named after the Greek goddess of memory — and it lives up to the name. It's a local-first note-taking app that knows you'll forget what you wrote. So instead of just storing your notes, it tracks how long ago you learned something and brings it back to the surface right before it fades from memory.

Write your notes, highlight what matters, and let Mnemosyne do the rest — quizzing you with AI-generated questions, flagging what needs review, and keeping your knowledge sharp over time.

---

## ✨ Features

- **Notebooks → Sections → Pages** — clean hierarchy for organizing everything you learn
- **Knowledge Decay Tracker** — concepts fade over time; Mnemosyne surfaces them before you forget
- **AI-Powered Quiz Generation** — generates multiple-choice questions from your notes using GitHub Models (GPT-4o / GPT-5)
- **Highlight & Track** — mark important passages directly in the editor and promote them into tracked concepts
- **Spaced Repetition Reviews** — SM-2-inspired scheduling spaces out when concepts resurface for review
- **Note Health Analysis** — flags notes that are too short, lack examples, or need more substance
- **Import** — bring in content from PDF, plain text, and Markdown files
- **Export** — save everything as Markdown, JSON, or a print-ready PDF
- **Fully Local** — all data stored on your device; no accounts, no cloud, no subscriptions

---

## 🚀 Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- A [GitHub personal access token](https://github.com/settings/tokens) (for AI features — no scopes needed)

### Install & Run

```bash
# Clone the repo
git clone https://github.com/xahani/mnemosyne.git
cd mnemosyne

# Install dependencies
npm install

# Start the app
npm start
```

### Build for Distribution

```bash
npm run dist:win      # Windows
npm run dist:mac      # macOS
npm run dist:linux    # Linux
```

---

## 🤖 Enabling AI Features

1. Open the app and click **⚙ Settings** in the top bar
2. Go to [github.com](https://github.com) → Settings → Developer settings → Personal access tokens → Tokens (classic)
3. Generate a new token — no scopes needed
4. Paste it into the token field and click **Save settings**

Your token is stored locally on your device only and never sent to any third-party server.

---

## 🛠 Built With

- [Electron](https://www.electronjs.org/)
- Vanilla JavaScript
- [GitHub Models API](https://github.com/marketplace/models)

---

## 📄 License

MIT
