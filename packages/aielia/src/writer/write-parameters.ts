/**
 * The adjustments a writer can ask for in the chat. Each is a parameter with suggested options; the writer can pick one or type their own, or
 * use "something else" for an aspect that is not listed. Choosing one composes an instruction that is sent like any other chat message.
 * Two kinds, which only change the wording of that instruction: "setting" (how the article should be written: tone, length, audience ...) and
 * "revision" (a one-off action on the text: shorten the introduction, add examples ...). The first group is shown straight away; the rest sit under Advanced.
 */

export type ParameterGroup = 'basics' | 'revise' | 'advanced'
export type ParameterKind = 'setting' | 'revision'

export interface WriteParameter {
  id: string
  label: string
  options: string[]
  group: ParameterGroup
  kind: ParameterKind
}

const slug = (label: string): string => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

function p(label: string, options: string, group: ParameterGroup = 'advanced', kind: ParameterKind = 'setting'): WriteParameter {
  return { id: slug(label), label, options: options.split('|').map((o) => o.trim()), group, kind }
}

export const WRITE_PARAMETERS: WriteParameter[] = [
  // Basics: usually chosen for each article.
  p('Article type', 'Blog post|How-to guide|Tutorial|Listicle|Explainer|Opinion piece|Thought leadership|Product review|Comparison article|Case study|News article|Industry update|Ultimate guide|Pillar article|Interview|Q&A|Problem–solution article', 'basics'),
  p('Tone of voice', 'Professional|Conversational|Friendly|Authoritative|Witty|Persuasive|Inspirational|Empathetic|Neutral|Provocative', 'basics'),
  p('Formality', 'Very casual|Casual|Balanced|Formal|Highly formal', 'basics'),
  p('Target audience', 'General readers|Beginners|Industry professionals|Executives|Decision-makers|Technical experts|Developers|Students|Academics|Customers|Prospective buyers|Custom audience', 'basics'),
  p('Audience knowledge level', 'Beginner|Intermediate|Advanced|Expert', 'basics'),
  p('Article length', 'Short (300–500 words)|Standard (800–1,200 words)|Long-form (1,500–2,500 words)|In-depth (3,000+ words)|Custom word count', 'basics'),
  p('Level of detail', 'Concise|Standard|Detailed|Comprehensive', 'basics'),
  p('Point of view', 'First person singular (I)|First person plural (we)|Second person (you)|Third person|Objective', 'basics'),
  p('Marketing objective', 'Build awareness|Generate leads|Drive sales|Establish authority|Increase engagement|Support customers|Build trust', 'basics'),
  p('Regional language', 'English (US)|English (UK)|English (Australia)|German|French|Spanish|Other supported languages', 'basics'),

  // Revise: one-off actions on the text.
  p('Introduction revision', 'Shorten|Expand|Strengthen hook|Add a question|Add a statistic|Add a story', 'revise', 'revision'),
  p('Article revision', 'Shorten|Expand|Simplify|Improve flow|Reduce repetition|Improve transitions|Rewrite sections', 'revise', 'revision'),
  p('Tone revision', 'More conversational|More professional|More authoritative|More persuasive|More engaging|More empathetic', 'revise', 'revision'),
  p('SEO revision', 'Improve keyword placement|Rewrite headings|Improve metadata|Add FAQs|Suggest internal links', 'revise', 'revision'),
  p('Content enrichment', 'Add examples|Add statistics|Add expert insights|Add case studies|Add sources|Add practical steps', 'revise', 'revision'),
  p('Conclusion revision', 'Summarize|Strengthen recommendations|Add key takeaways|Add CTA', 'revise', 'revision'),

  // Advanced: everything else.
  p('Language complexity', 'Plain language|Everyday language|Intermediate|Advanced|Specialist|Academic'),
  p('Sentence style', 'Short and punchy|Balanced|Long and descriptive|Varied'),
  p('Vocabulary', 'Simple|Everyday|Industry-specific|Technical|Academic'),
  p('Emotional intensity', 'Neutral|Warm|Enthusiastic|Urgent|Passionate'),
  p('Persuasiveness', 'Informative|Subtly persuasive|Moderately persuasive|Strongly persuasive'),
  p('Humour', 'None|Light|Playful|Witty|Sarcastic'),
  p('Narrative approach', 'Direct|Storytelling|Anecdotal|Data-driven|Problem-first|Solution-first'),
  p('Brand voice', 'Corporate|Personal brand|Thought leader|Startup|Editorial|Luxury brand|Playful|Custom'),
  p('Writing originality', 'Conventional|Distinctive|Creative|Experimental'),
  p('Introduction style', 'Direct answer|Question|Surprising fact|Statistic|Anecdote|Story|Problem statement'),
  p('Heading style', 'Descriptive|Question-based|SEO-focused|Creative|Benefit-driven'),
  p('Paragraph length', 'Short|Medium|Long'),
  p('Use of bullet points', 'None|Occasional|Frequent'),
  p('Use of examples', 'None|A few examples|Multiple examples|Detailed real-world examples'),
  p('Use of data and statistics', 'Minimal|Moderate|Extensive'),
  p('Use of tables', 'None|Summary tables|Comparison tables|Data tables'),
  p('Conclusion style', 'Summary|Key takeaways|Recommendation|Call to action|Open-ended conclusion'),
  p('Additional sections', 'FAQ|Checklist|Glossary|Key takeaways|Resources|Executive summary|Further reading'),
  p('Formatting style', 'Traditional article|Scannable web content|Magazine style|Narrative format|Structured guide'),
  p('Primary keyword', 'User-defined keyword|Automatically suggested keyword|Multiple target keywords'),
  p('Secondary keywords', 'User-defined terms|AI-suggested terms|Semantic variations|Related search queries'),
  p('Search intent', 'Informational|Commercial investigation|Transactional|Navigational'),
  p('SEO optimization level', 'None|Light|Balanced|Strong'),
  p('Heading hierarchy', 'Standard H1/H2/H3|Simplified headings|Custom hierarchy'),
  p('Meta title', 'Auto-generated|User-defined|SEO-optimized|Multiple suggestions'),
  p('Meta description', 'Auto-generated|User-defined|SEO-optimized|Multiple suggestions'),
  p('URL slug', 'Auto-generated|Keyword-focused|Custom'),
  p('Internal linking', 'Disabled|Suggest links|Use supplied URLs|Automatically incorporate approved links'),
  p('External linking', 'None|A few authoritative sources|Extensive references|User-supplied sources only'),
  p('FAQ optimization', 'Disabled|User-provided questions|AI-generated questions|Search-intent-based questions'),
  p('Featured snippet optimization', 'Disabled|Concise answer|Definition format|Step-by-step format|List format'),
  p('Readability optimization', 'Disabled|Basic|Standard|High readability'),
  p('Content gap analysis', 'Disabled|Basic|Competitor-based|Comprehensive'),
  p('Research mode', 'Existing model knowledge|User-provided material|Web research|In-depth research'),
  p('Source preference', 'Official documentation|Academic research|Industry reports|Reputable news|Expert publications|User-provided sources'),
  p('Citation style', 'No citations|Inline hyperlinks|Footnotes|Numbered references|APA|MLA|Chicago'),
  p('Fact-checking', 'Disabled|Basic checks|Verify key claims|Comprehensive verification'),
  p('Content freshness', 'Evergreen|Last 12 months|Last 90 days|Latest available information|Custom date range'),
  p('Source restrictions', 'Any reliable source|Approved domains only|Supplied documents only|Exclude specified domains or competitors'),
  p('Factuality and opinion', 'Strictly factual|Balanced analysis|Expert commentary|Opinion-led'),
  p('Uncertainty handling', 'Omit uncertain claims|Flag for review|Explain limitations'),
  p('Writing profile', 'Default profile|Corporate|Personal brand|Editorial|Custom profile'),
  p('Custom writing style', 'Use a writing sample|Learn from previous articles|Follow a style guide|Manually define rules'),
  p('Brand terminology', 'Preferred terms|Required phrases|Product names|Prohibited words|Terminology glossary'),
  p('Grammar preferences', 'Oxford comma on/off|Capitalization rules|Punctuation preferences|Custom grammar rules'),
  p('Localization', 'No localization|Spelling only|Regional terminology|Full cultural localization'),
  p('Translation approach', 'Direct translation|Natural translation|Transcreation|Localized rewrite'),
  p('Reading level', 'General audience|Beginner|Intermediate|Advanced|Specialist|Grade-level target'),
  p('Accessibility', 'Plain language|Explain acronyms|Minimize jargon|Descriptive headings|Accessibility-focused formatting'),
  p('Inclusive language', 'Standard|Inclusive-language preference|Custom terminology rules'),
  p('Call to action (CTA)', 'None|Newsletter signup|Download resource|Contact sales|Book a demo|Purchase|Read another article|Custom CTA'),
  p('CTA strength', 'Subtle|Moderate|Direct|Highly persuasive'),
  p('Product promotion', 'None|Occasional mentions|Balanced promotion|Strong promotional focus'),
  p('Competitor mentions', 'Avoid competitors|Mention selectively|Neutral comparisons|Detailed comparisons'),
  p('Output format', 'Markdown|Rich text|HTML|Plain text|CMS-ready content|Custom template'),
  p('Output language', 'English|German|French|Spanish|Other supported languages'),
  p('Number of variations', 'One draft|Multiple drafts|Alternative headlines|Alternative introductions|Multiple full versions'),
  p('Saved preferences', 'Default settings|Saved brand voices|Audience personas|Article templates|Reusable SEO settings'),
  p('Knowledge sources', 'No additional sources|Uploaded documents|Company knowledge base|Product documentation|Approved websites'),
  p('Compliance rules', 'No additional restrictions|Required disclaimers|Prohibited claims|Regulated-industry rules|Custom policies'),
]

export function findParameter(id: string): WriteParameter | undefined {
  return WRITE_PARAMETERS.find((x) => x.id === id)
}

export const PARAMETER_GROUPS: { id: ParameterGroup; label: string }[] = [
  { id: 'basics', label: 'Basics' },
  { id: 'revise', label: 'Revise the text' },
  { id: 'advanced', label: 'Advanced' },
]

/** The chat message an adjustment turns into. Any aspect and any value are accepted, listed or not. */
export function adjustmentInstruction(aspect: string, value: string, kind: ParameterKind): string {
  const a = aspect.trim()
  const v = value.trim()
  if (kind === 'revision') return `${a}: ${v}. Suggest the edits that do this, and change nothing else.`
  return `Adjust the article so that its ${a.toLowerCase()} is: ${v}. Suggest the edits that bring the text in line, and change nothing that does not need to change.`
}
