/**
 * AL5b — classifier eval turns for the five AL5a signal fields. These are UNLABELLED on purpose:
 * labels come from `scripts/label-turn-signals.ts`, which runs a different, stronger model family
 * than the classifier (double pass, per-field disagreements dropped) — never from the classifier
 * itself (circular) and never hand-written here. `covers` records which field each turn is meant to
 * exercise (including negatives), so coverage can be checked without knowing the label.
 */
export type TurnSignalField = 'needsGrounding' | 'ambiguity' | 'userPosture' | 'pushbackOnPriorTurn' | 'statesConstraint'

export interface TurnSignalTurn {
  id: string
  lang: string
  message: string
  covers: TurnSignalField[]
}

type Row = [lang: string, message: string, ...covers: TurnSignalField[]]
const G: TurnSignalField = 'needsGrounding'
const A: TurnSignalField = 'ambiguity'
const P: TurnSignalField = 'userPosture'
const B: TurnSignalField = 'pushbackOnPriorTurn'
const C: TurnSignalField = 'statesConstraint'

const ROWS: Row[] = [
  // needsGrounding: positives (current/verifiable facts) and negatives (pure reasoning, creative, chit-chat)
  ['en', 'What is the current price of Bitcoin?', G],
  ['en', 'Who won the most recent Formula 1 race?', G],
  ['en', 'Check whether the file config.json in my project still contains a "debug" key.', G],
  ['en', 'What does the latest version of React say about server components?', G],
  ['en', 'Is the pharmacy on Main Street open right now?', G],
  ['en', 'How many open issues does the vitest repo have today?', G],
  ['en', 'What is the exchange rate from GBP to JPY this morning?', G],
  ['en', 'Look at package.json and tell me which version of typescript we depend on.', G],
  ['en', 'Write a haiku about autumn rain.', G, P],
  ['en', 'Explain what a closure is in JavaScript.', G, P],
  ['en', 'Help me come up with a name for my bakery.', G, P],
  ['en', 'What is 17 times 23?', G],
  ['en', 'Rewrite this sentence to sound more formal: "hey, can u send that over?"', G, P],
  ['en', 'Thanks, that was helpful!', G, P],
  ['en', 'Tell me a joke about programmers.', G],
  ['en', 'Summarise the plot of Romeo and Juliet in two sentences.', G],
  ['zh', '现在北京的天气怎么样？', G],
  ['zh', '请帮我查一下今天的美元兑人民币汇率。', G],
  ['zh', '给我写一首关于春天的短诗。', G],
  ['es', '¿Cuál es el precio actual del petróleo Brent?', G],
  ['es', 'Explícame la diferencia entre "ser" y "estar".', G],
  ['fr', 'Quel est le résultat du dernier match du PSG ?', G],
  ['de', 'Erkläre mir bitte, wie ein Hash-Table funktioniert.', G],
  ['ja', '今日の東京の最高気温は何度ですか？', G],
  // ambiguity: none / some / high
  ['en', 'Rename the function parseDate to parseIsoDate in src/utils/date.ts.', A, P],
  ['en', 'Convert 100 degrees Fahrenheit to Celsius.', A],
  ['en', 'Delete the file notes/old-draft.txt.', A, P],
  ['en', 'Set a reminder for 9am tomorrow to call the dentist.', A, P],
  ['en', 'Fix it.', A, P],
  ['en', 'Do the thing we talked about.', A, P],
  ['en', 'Make it better.', A],
  ['en', 'Send that to them.', A, P],
  ['en', 'Clean up the project.', A, P],
  ['en', 'Book me a flight next week.', A, P],
  ['en', 'Update the report with the new numbers.', A],
  ['en', 'Can you look into the slow page?', A, P],
  ['en', 'Move the meeting to later.', A],
  ['en', 'Add a test for the retry logic in src/retry.ts that checks it stops after three attempts.', A, P],
  ['en', 'Translate "good morning" into Italian.', A],
  ['zh', '把它删掉。', A],
  ['zh', '把 src/main.ts 里的变量 count 重命名为 total。', A],
  ['es', 'Arréglalo.', A],
  ['fr', 'Envoie le fichier à Marie.', A],
  ['de', 'Benenne die Datei report.txt in bericht.txt um.', A],
  ['ja', 'あれをやっておいて。', A],
  // userPosture: informational / directive / exploratory / corrective
  ['en', 'What is the difference between TCP and UDP?', P],
  ['en', 'How does garbage collection work in Go?', P],
  ['en', 'Why is the sky blue?', P],
  ['en', 'Run the linter on the adapter directory.', P],
  ['en', 'Create a new file called todo.md with three bullet points.', P],
  ['en', 'Schedule a call with Priya for Friday afternoon.', P],
  ['en', "I'm thinking about switching from Postgres to SQLite for this side project. What are the tradeoffs?", P],
  ['en', 'Let\'s brainstorm ways to reduce our onboarding drop-off.', P],
  ['en', 'I wonder whether a monorepo would suit us. Thoughts?', P],
  ['en', 'What if we cached the results instead of recomputing them?', P],
  ['en', 'Maybe I should learn Rust — is that a good idea for someone who does mostly web work?', P],
  ['en', "That's not what I asked for. I wanted a summary, not a rewrite.", P, B],
  ['en', 'Actually, use tabs, not spaces.', P, B, C],
  ['zh', '什么是死锁？', P],
  ['zh', '运行一下测试并告诉我结果。', P],
  ['zh', '我在想要不要换一份工作，你怎么看？', P],
  ['es', '¿Qué es la inflación?', P],
  ['es', 'Genera un resumen de este documento.', P],
  ['fr', 'Je me demande si je devrais apprendre le piano à mon âge.', P],
  ['de', 'Erstelle bitte eine Liste mit fünf Ideen für ein Wochenende.', P],
  ['ja', 'ダークモードを追加してください。', P],
  // pushbackOnPriorTurn: positives and negatives
  ['en', "No, that's wrong. The capital of Australia is Canberra, not Sydney.", B],
  ['en', "That doesn't look right — the total should be 42, not 24.", B],
  ['en', "You misunderstood me. I said the second paragraph, not the first.", B],
  ['en', "That still fails. The same error is back.", B],
  ['en', "I don't think that's correct; the docs say the default is 30 seconds.", B],
  ['en', "Hmm, that's not what I meant at all.", B],
  ['en', 'You forgot the part about error handling.', B],
  ['en', "Wrong file — I meant config.prod.json.", B],
  ['en', 'Great, that works. Now add logging.', B],
  ['en', 'Yes, exactly right. Please continue.', B],
  ['en', 'Perfect, thank you.', B],
  ['en', 'OK, and what about the second option?', B],
  ['en', 'Sure, go ahead.', B],
  ['zh', '不对，你算错了，应该是 42。', B],
  ['zh', '不是这个意思，我要的是第二段。', B],
  ['zh', '对，就是这样，继续吧。', B],
  ['es', 'No, eso está mal. Te pedí el segundo párrafo.', B],
  ['es', 'Perfecto, gracias. Sigue con el siguiente.', B],
  ['fr', "Non, ce n'est pas correct, le total devrait être 42.", B],
  ['de', 'Das stimmt nicht — der Standardwert ist 30 Sekunden.', B],
  ['ja', 'それは違います。二番目の段落のことです。', B],
  // statesConstraint: positives (rule governing later turns) and negatives (one-off instruction)
  ['en', 'From now on, always answer in bullet points.', C],
  ['en', 'Never run shell commands without asking me first.', C],
  ['en', 'Only use British spelling in anything you write for me.', C],
  ['en', 'Going forward, keep every reply under 100 words.', C],
  ['en', "Don't touch anything in the vendor/ directory.", C],
  ['en', 'For the rest of this project, use pnpm rather than npm.', C],
  ['en', 'Please never email my manager on my behalf.', C],
  ['en', 'Always ask before deleting a file.', C],
  ['en', 'Make this reply shorter.', C],
  ['en', 'Use bullet points for this one answer.', C],
  ['en', 'Delete the temp file.', C],
  ['en', 'Write me a short poem.', C],
  ['en', 'Can you explain that in simpler terms?', C],
  ['en', 'Just this once, skip the intro.', C],
  ['zh', '以后所有回答都请用中文。', C],
  ['zh', '永远不要在没问我的情况下删除文件。', C],
  ['zh', '把这段话缩短一点。', C],
  ['es', 'A partir de ahora, responde siempre con listas.', C],
  ['es', 'Hazlo más corto, por favor.', C],
  ['fr', 'Désormais, ne modifie jamais le dossier vendor/.', C],
  ['de', 'Ab jetzt antworte bitte immer auf Deutsch.', C],
  ['ja', '今後は必ず箇条書きで答えてください。', C],
  // mixed / multi-field turns
  ['en', "No, don't do that — never overwrite my backups, and check the current disk usage first.", B, C, G, P],
  ['en', "Stop. You changed the wrong branch. From now on confirm the branch name before pushing.", B, C, P],
  ['en', "What's the latest stable Node version, and should we upgrade? I'm not sure yet.", G, P],
  ['en', 'Look up the current weather in Lisbon and suggest what to wear.', G, P],
  ['en', "Let's think through how to structure the migration; we can't touch the production database directly.", P, C],
  ['en', 'Which is better?', A, P],
  ['en', 'Check the build status of the last commit and re-run it if it failed.', G, P],
  ['en', 'I disagree — the second approach is slower, according to the benchmark I ran yesterday.', B],
  ['en', 'Only summarise the first page, and please verify the dates against the source.', C, G],
  ['en', 'hi', A, P],
  ['en', 'Tell me more.', A, P],
  ['en', 'What about the other one?', A],
  ['en', 'Please translate the attached document.', A],
  ['zh', '再检查一下最新的库存数量，然后告诉我。', G, P],
  ['es', 'No, no era eso. Nunca uses tablas, por favor.', B, C],
  ['fr', "Peux-tu vérifier le prix actuel de l'or ?", G],
  ['de', 'Das war falsch. Prüfe bitte den aktuellen Kurs noch einmal.', B, G],
  ['ja', '違います。今後は日付を必ず確認してください。', B, C],
]

export const TURN_SIGNAL_TURNS: TurnSignalTurn[] = ROWS.map(([lang, message, ...covers], i) => ({
  id: `ts-${String(i + 1).padStart(3, '0')}`,
  lang,
  message,
  covers,
}))
