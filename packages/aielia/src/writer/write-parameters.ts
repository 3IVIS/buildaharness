/**
 * The adjustments a writer can ask for in the chat. The first menu holds a handful of categories; picking one opens a single field whose
 * suggestions are "Aspect: option" pairs (type to filter, or type your own words). Whatever is sent becomes an ordinary chat message.
 * Two kinds, which only change the wording of the instruction: "setting" (how the article should be written: tone, length, audience ...)
 * and "revision" (a one-off action on the text: shorten the introduction, add examples ...).
 * Settings that are not about the text itself live elsewhere (Style tab, Sources tab, the Do actions) and are deliberately not repeated here.
 */

export type ParameterGroup = 'tone' | 'audience' | 'length' | 'structure' | 'seo' | 'sources' | 'promotion' | 'brand' | 'revise'
export type ParameterKind = 'setting' | 'revision'

export interface WriteParameter {
  id: string
  label: string
  options: string[]
  group: ParameterGroup
  kind: ParameterKind
}

const slug = (label: string): string => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

function p(label: string, options: string, group: ParameterGroup, kind: ParameterKind = 'setting'): WriteParameter {
  return { id: slug(label), label, options: options.split('|').map((o) => o.trim()), group, kind }
}

export const WRITE_PARAMETERS: WriteParameter[] = [
  p('Tone of voice', 'Professional|Conversational|Friendly|Authoritative|Witty|Persuasive|Inspirational|Empathetic|Neutral|Provocative|Warm|Enthusiastic|Urgent|Passionate', 'tone'),
  p('Formality', 'Very casual|Casual|Balanced|Formal|Highly formal', 'tone'),
  p('Point of view', 'First person singular (I)|First person plural (we)|Second person (you)|Third person|Objective', 'tone'),
  p('Sentence style', 'Short and punchy|Balanced|Long and descriptive|Varied', 'tone'),
  p('Humour', 'None|Light|Playful|Witty|Sarcastic', 'tone'),
  p('Persuasiveness', 'Informative|Subtly persuasive|Moderately persuasive|Strongly persuasive', 'tone'),
  p('Narrative approach', 'Direct|Storytelling|Anecdotal|Data-driven|Problem-first|Solution-first', 'tone'),
  p('Factuality and opinion', 'Strictly factual|Balanced analysis|Expert commentary|Opinion-led', 'tone'),

  p('Target audience', 'General readers|Beginners|Industry professionals|Executives|Decision-makers|Technical experts|Developers|Students|Academics|Customers|Prospective buyers', 'audience'),
  p('Knowledge level', 'Beginner|Intermediate|Advanced|Expert', 'audience'),
  p('Language and vocabulary', 'Plain language|Everyday language|Industry-specific terms|Technical|Academic|Explain acronyms|Minimize jargon', 'audience'),
  p('Accessibility', 'Descriptive headings|Accessibility-focused formatting|Inclusive language', 'audience'),

  p('Article length', 'Short (300–500 words)|Standard (800–1,200 words)|Long-form (1,500–2,500 words)|In-depth (3,000+ words)', 'length'),
  p('Level of detail', 'Concise|Standard|Detailed|Comprehensive', 'length'),
  p('Paragraph length', 'Short|Medium|Long', 'length'),
  p('Use of examples', 'None|A few examples|Multiple examples|Detailed real-world examples', 'length'),
  p('Use of data and statistics', 'Minimal|Moderate|Extensive', 'length'),

  p('Article type', 'Blog post|How-to guide|Tutorial|Listicle|Explainer|Opinion piece|Thought leadership|Product review|Comparison article|Case study|News article|Interview|Q&A|Problem–solution article', 'structure'),
  p('Introduction style', 'Direct answer|Question|Surprising fact|Statistic|Anecdote|Story|Problem statement', 'structure'),
  p('Heading style', 'Descriptive|Question-based|SEO-focused|Creative|Benefit-driven', 'structure'),
  p('Use of bullet points', 'None|Occasional|Frequent', 'structure'),
  p('Use of tables', 'None|Summary tables|Comparison tables|Data tables', 'structure'),
  p('Conclusion style', 'Summary|Key takeaways|Recommendation|Call to action|Open-ended conclusion', 'structure'),
  p('Additional sections', 'FAQ|Checklist|Glossary|Key takeaways|Resources|Executive summary|Further reading', 'structure'),
  p('Formatting style', 'Traditional article|Scannable web content|Magazine style|Narrative format|Structured guide', 'structure'),

  p('Primary keyword', 'Suggest a keyword|Use my keyword|Several target keywords', 'seo'),
  p('Secondary keywords', 'Suggest related terms|Semantic variations|Related search queries', 'seo'),
  p('Search intent', 'Informational|Commercial investigation|Transactional|Navigational', 'seo'),
  p('SEO optimization level', 'None|Light|Balanced|Strong', 'seo'),
  p('Metadata', 'Write a meta title|Write a meta description|Suggest a URL slug|Write all three', 'seo'),
  p('Internal linking', 'Suggest links|Use supplied URLs', 'seo'),
  p('FAQ and featured snippet', 'Add FAQ questions|Concise answer|Definition format|Step-by-step format|List format', 'seo'),

  p('External linking', 'None|A few authoritative sources|Extensive references|Supplied sources only', 'sources'),
  p('Source preference', 'Official documentation|Academic research|Industry reports|Reputable news|Expert publications|Supplied sources', 'sources'),
  p('Citation style', 'No citations|Inline hyperlinks|Footnotes|Numbered references|APA|MLA|Chicago', 'sources'),
  p('Content freshness', 'Evergreen|Last 12 months|Last 90 days|Latest available information', 'sources'),
  p('Uncertain claims', 'Omit them|Flag for review|Explain the limitations', 'sources'),

  p('Marketing objective', 'Build awareness|Generate leads|Drive sales|Establish authority|Increase engagement|Support customers|Build trust', 'promotion'),
  p('Call to action (CTA)', 'None|Newsletter signup|Download resource|Contact sales|Book a demo|Purchase|Read another article', 'promotion'),
  p('CTA strength', 'Subtle|Moderate|Direct|Highly persuasive', 'promotion'),
  p('Product promotion', 'None|Occasional mentions|Balanced promotion|Strong promotional focus', 'promotion'),
  p('Competitor mentions', 'Avoid competitors|Mention selectively|Neutral comparisons|Detailed comparisons', 'promotion'),

  p('Language and region', 'English (US)|English (UK)|English (Australia)|German|French|Spanish|Spelling only|Regional terminology|Translate naturally|Localize fully', 'brand'),
  p('Brand voice', 'Corporate|Personal brand|Thought leader|Startup|Editorial|Luxury brand|Playful', 'brand'),
  p('Brand terminology', 'Use preferred terms|Use required phrases|Avoid prohibited words', 'brand'),
  p('Grammar preferences', 'Oxford comma on|Oxford comma off|Capitalization rules|Punctuation preferences', 'brand'),
  p('Compliance', 'Add required disclaimers|Remove prohibited claims|Regulated-industry wording', 'brand'),

  p('Introduction revision', 'Shorten|Expand|Strengthen hook|Add a question|Add a statistic|Add a story', 'revise', 'revision'),
  p('Article revision', 'Shorten|Expand|Simplify|Improve flow|Reduce repetition|Improve transitions|Rewrite sections', 'revise', 'revision'),
  p('Content enrichment', 'Add examples|Add statistics|Add expert insights|Add case studies|Add sources|Add practical steps', 'revise', 'revision'),
  p('SEO revision', 'Improve keyword placement|Rewrite headings|Improve metadata|Add FAQs|Suggest internal links', 'revise', 'revision'),
  p('Conclusion revision', 'Summarize|Strengthen recommendations|Add key takeaways|Add CTA', 'revise', 'revision'),
  p('Alternatives', 'Alternative headlines|Alternative introductions|A second version of a section', 'revise', 'revision'),
]

export function findParameter(id: string): WriteParameter | undefined {
  return WRITE_PARAMETERS.find((x) => x.id === id)
}

export const PARAMETER_GROUPS: { id: ParameterGroup; label: string }[] = [
  { id: 'tone', label: 'Tone and voice' },
  { id: 'audience', label: 'Audience and reading level' },
  { id: 'length', label: 'Length and detail' },
  { id: 'structure', label: 'Structure and format' },
  { id: 'seo', label: 'Search (SEO)' },
  { id: 'sources', label: 'Sources and citations' },
  { id: 'promotion', label: 'Goal and calls to action' },
  { id: 'brand', label: 'Brand and language' },
  { id: 'revise', label: 'Revise the text' },
]

/** The suggestions of a category, each one "Aspect: option". */
export function adjustmentChoices(group: ParameterGroup): string[] {
  return WRITE_PARAMETERS.filter((x) => x.group === group).flatMap((x) => x.options.map((o) => `${x.label}: ${o}`))
}

/** The chat message an adjustment turns into. Any aspect and any value are accepted, listed or not. */
export function adjustmentInstruction(aspect: string, value: string, kind: ParameterKind): string {
  const a = aspect.trim()
  const v = value.trim()
  if (kind === 'revision') return `${a}: ${v}. Suggest the edits that do this, and change nothing else.`
  return `Adjust the article so that its ${a.toLowerCase()} is: ${v}. Suggest the edits that bring the text in line, and change nothing that does not need to change.`
}

/**
 * What the writer typed in a category's field. A suggestion ("Tone of voice: Witty", or its aspect with a value of their own) keeps its
 * aspect; any other words are taken as the request itself. `group` is absent for "Something else".
 */
export function adjustmentFromText(group: ParameterGroup | undefined, text: string): string {
  const t = text.trim()
  const colon = t.indexOf(':')
  if (group && colon > 0) {
    const param = WRITE_PARAMETERS.find((x) => x.group === group && x.label.toLowerCase() === t.slice(0, colon).trim().toLowerCase())
    if (param && t.slice(colon + 1).trim()) return adjustmentInstruction(param.label, t.slice(colon + 1), param.kind)
  }
  if (group === 'revise') return `${t}. Suggest the edits that do this, and change nothing else.`
  return `Adjust the article: ${t}. Suggest the edits that bring the text in line, and change nothing that does not need to change.`
}
