# Turn-signal label spot check (AL5b)

Non-blocking. Mark any label you disagree with; record in the accuracy table that the review happened.

- **ts-001** (en) — "What is the current price of Bitcoin?"
  labels: `{"needsGrounding":true,"ambiguity":"none","userPosture":"informational","pushbackOnPriorTurn":false,"statesConstraint":false}` · labeller: claude-opus-5-5
- **ts-003** (en) — "Check whether the file config.json in my project still contains a \"debug\" key."
  labels: `{"needsGrounding":true,"ambiguity":"some","userPosture":"directive","pushbackOnPriorTurn":false,"statesConstraint":false}` · labeller: claude-opus-5-5
- **ts-011** (en) — "Help me come up with a name for my bakery."
  labels: `{"needsGrounding":false,"ambiguity":"some","userPosture":"exploratory","pushbackOnPriorTurn":false,"statesConstraint":false}` · labeller: claude-opus-5-5
- **ts-019** (zh) — "给我写一首关于春天的短诗。"
  labels: `{"needsGrounding":false,"ambiguity":"some","userPosture":"directive","pushbackOnPriorTurn":false,"statesConstraint":false}` · labeller: claude-opus-5-5
- **ts-015** (en) — "Tell me a joke about programmers."
  labels: `{"needsGrounding":false,"ambiguity":"none","userPosture":"directive","pushbackOnPriorTurn":false,"statesConstraint":false}` · labeller: claude-opus-5-5
- **ts-101** (en) — "Just this once, skip the intro."
  labels: `{"needsGrounding":false,"userPosture":"directive","pushbackOnPriorTurn":false,"statesConstraint":false}` · labeller: claude-opus-5-5
- **ts-025** (en) — "Rename the function parseDate to parseIsoDate in src/utils/date.ts."
  labels: `{"needsGrounding":true,"userPosture":"directive","pushbackOnPriorTurn":false,"statesConstraint":false}` · labeller: claude-opus-5-5
- **ts-123** (zh) — "再检查一下最新的库存数量，然后告诉我。"
  labels: `{"needsGrounding":true,"ambiguity":"some","userPosture":"directive","pushbackOnPriorTurn":false,"statesConstraint":false}` · labeller: claude-opus-5-5
- **ts-057** (en) — "That's not what I asked for. I wanted a summary, not a rewrite."
  labels: `{"needsGrounding":false,"ambiguity":"some","userPosture":"corrective","pushbackOnPriorTurn":true,"statesConstraint":false}` · labeller: claude-opus-5-5
- **ts-092** (en) — "Don't touch anything in the vendor/ directory."
  labels: `{"needsGrounding":false,"ambiguity":"none","userPosture":"directive","pushbackOnPriorTurn":false,"statesConstraint":true}` · labeller: claude-opus-5-5
- **ts-047** (en) — "How does garbage collection work in Go?"
  labels: `{"needsGrounding":false,"userPosture":"informational","pushbackOnPriorTurn":false,"statesConstraint":false}` · labeller: claude-opus-5-5
- **ts-043** (fr) — "Envoie le fichier à Marie."
  labels: `{"needsGrounding":true,"ambiguity":"high","userPosture":"directive","pushbackOnPriorTurn":false,"statesConstraint":false}` · labeller: claude-opus-5-5
- **ts-036** (en) — "Can you look into the slow page?"
  labels: `{"needsGrounding":true,"ambiguity":"high","userPosture":"directive","pushbackOnPriorTurn":false,"statesConstraint":false}` · labeller: claude-opus-5-5
- **ts-099** (en) — "Write me a short poem."
  labels: `{"needsGrounding":false,"ambiguity":"some","userPosture":"directive","pushbackOnPriorTurn":false,"statesConstraint":false}` · labeller: claude-opus-5-5
- **ts-125** (fr) — "Peux-tu vérifier le prix actuel de l'or ?"
  labels: `{"needsGrounding":true,"ambiguity":"some","pushbackOnPriorTurn":false,"statesConstraint":false}` · labeller: claude-opus-5-5
- **ts-028** (en) — "Set a reminder for 9am tomorrow to call the dentist."
  labels: `{"needsGrounding":true,"ambiguity":"none","userPosture":"directive","pushbackOnPriorTurn":false,"statesConstraint":false}` · labeller: claude-opus-5-5
- **ts-029** (en) — "Fix it."
  labels: `{"needsGrounding":true,"ambiguity":"high","userPosture":"directive","pushbackOnPriorTurn":false,"statesConstraint":false}` · labeller: claude-opus-5-5
- **ts-088** (en) — "From now on, always answer in bullet points."
  labels: `{"needsGrounding":false,"ambiguity":"none","userPosture":"directive","pushbackOnPriorTurn":false,"statesConstraint":true}` · labeller: claude-opus-5-5
- **ts-008** (en) — "Look at package.json and tell me which version of typescript we depend on."
  labels: `{"needsGrounding":true,"ambiguity":"none","pushbackOnPriorTurn":false,"statesConstraint":false}` · labeller: claude-opus-5-5
- **ts-038** (en) — "Add a test for the retry logic in src/retry.ts that checks it stops after three attempts."
  labels: `{"needsGrounding":true,"ambiguity":"some","userPosture":"directive","pushbackOnPriorTurn":false,"statesConstraint":false}` · labeller: claude-opus-5-5
- **ts-087** (ja) — "それは違います。二番目の段落のことです。"
  labels: `{"needsGrounding":false,"ambiguity":"some","userPosture":"corrective","pushbackOnPriorTurn":true,"statesConstraint":false}` · labeller: claude-opus-5-5
- **ts-030** (en) — "Do the thing we talked about."
  labels: `{"needsGrounding":false,"ambiguity":"high","userPosture":"directive","pushbackOnPriorTurn":false,"statesConstraint":false}` · labeller: claude-opus-5-5
- **ts-045** (ja) — "あれをやっておいて。"
  labels: `{"needsGrounding":false,"ambiguity":"high","userPosture":"directive","pushbackOnPriorTurn":false,"statesConstraint":false}` · labeller: claude-opus-5-5
- **ts-089** (en) — "Never run shell commands without asking me first."
  labels: `{"needsGrounding":false,"ambiguity":"none","userPosture":"directive","pushbackOnPriorTurn":false,"statesConstraint":true}` · labeller: claude-opus-5-5
- **ts-012** (en) — "What is 17 times 23?"
  labels: `{"needsGrounding":false,"ambiguity":"none","userPosture":"informational","pushbackOnPriorTurn":false,"statesConstraint":false}` · labeller: claude-opus-5-5
- **ts-071** (en) — "I don't think that's correct; the docs say the default is 30 seconds."
  labels: `{"needsGrounding":true,"ambiguity":"some","userPosture":"corrective","pushbackOnPriorTurn":true,"statesConstraint":false}` · labeller: claude-opus-5-5
- **ts-013** (en) — "Rewrite this sentence to sound more formal: \"hey, can u send that over?\""
  labels: `{"needsGrounding":false,"ambiguity":"none","userPosture":"directive","pushbackOnPriorTurn":false,"statesConstraint":false}` · labeller: claude-opus-5-5
- **ts-116** (en) — "Check the build status of the last commit and re-run it if it failed."
  labels: `{"needsGrounding":true,"ambiguity":"some","userPosture":"directive","pushbackOnPriorTurn":false,"statesConstraint":false}` · labeller: claude-opus-5-5
- **ts-077** (en) — "Perfect, thank you."
  labels: `{"needsGrounding":false,"ambiguity":"none","userPosture":"informational","pushbackOnPriorTurn":false,"statesConstraint":false}` · labeller: claude-opus-5-5
- **ts-078** (en) — "OK, and what about the second option?"
  labels: `{"needsGrounding":false,"ambiguity":"high","pushbackOnPriorTurn":false,"statesConstraint":false}` · labeller: claude-opus-5-5
