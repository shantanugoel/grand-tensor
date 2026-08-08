/** The settings modal: renders a form from the Settings object and reads it back.
 *
 *  Reasoning efforts aren't a fixed list — each model publishes the ones it
 *  accepts, so the dropdowns are rebuilt from the endpoint's /models listing
 *  whenever a model id changes. */

import { fetchModels, FALLBACK_EFFORTS, type ModelInfo } from '../llm'
import { PROMPT_VARIABLES, systemPrompt } from '../prompt'
import { CIRCUITS, inspectEligibility } from '../leaderboard-protocol'
import { DEFAULTS, NO_EFFORT, normalizeReasoningEffort, REASONING_OFF, type Settings } from '../settings'

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T

let known = new Map<string, ModelInfo>()

// Keep the form constraint and the save-time clamp tied to the ranked protocol.
// A stale literal here previously displayed 128,000 correctly, then interpreted
// it as 32,000 for both live eligibility and saving.
const MAX_TOKENS = Math.max(...CIRCUITS.map((circuit) => circuit.maxTokens))

const text = (name: string, label: string, value: string, type = 'text', extra = '', help = '') =>
  `<label class="field">${label}<input name="${name}" type="${type}" value="${escapeAttr(value)}" ${extra}/>${help ? `<span class="field-help">${help}</span>` : ''}</label>`

const num = (name: string, label: string, value: number, min: number, max: number, step = 1, help = '') =>
  `<label class="field">${label}<input name="${name}" type="number" value="${value}" min="${min}" max="${max}" step="${step}"/>${help ? `<span class="field-help">${help}</span>` : ''}</label>`

const textarea = (name: string, label: string, value: string) =>
  `<label class="field prompt-field">${label}<textarea name="${name}" rows="14">${escapeHtml(value)}</textarea></label>`

function playerFieldset(i: number, s: Settings) {
  const p = s.players[i]
  return `
    <fieldset class="fieldset">
      <legend>PLAYER ${i + 1}</legend>
      <div class="grid">
        ${text(`p${i}_label`, 'Display name', p.label, 'text', '', 'What this side is called on the vitality bar and in the battle log.')}
        ${text(`p${i}_model`, 'Model id', p.model, 'text', `list="model-list" autocomplete="off" data-model="${i}"`, 'Use <code>random</code> for a local, no-API demo.')}
        <label class="field">Reasoning effort<select name="p${i}_effort"></select><span class="field-help">Rebuilt from what this model says it accepts. <code>off</code> is a real setting, not a low level — some models only play at a sane speed and cost with it.</span></label>
        ${num(`p${i}_temperature`, 'Temperature', p.temperature, 0, 2, 0.1, 'Higher wanders further from the move it thinks is best. <code>0</code> is the steadiest play.')}
      </div>
    </fieldset>`
}

export function renderSettings(s: Settings) {
  $('#settings-form').innerHTML = `
    <div id="eligibility" class="eligibility"></div>
    <fieldset class="fieldset">
      <legend>ENDPOINT</legend>
      <div class="grid">
        ${text('baseUrl', 'Base URL (OpenAI-compatible)', s.baseUrl, 'text', '', 'Works with any <code>/chat/completions</code> endpoint.')}
        ${text('apiKey', 'API key', s.apiKey, 'password', '', 'Stored only in this browser and sent directly to this endpoint.')}
      </div>
    </fieldset>
    ${playerFieldset(0, s)}
    ${playerFieldset(1, s)}
    <fieldset class="fieldset">
      <legend>MATCH</legend>
      <div class="grid">
        ${num('games', 'Games in series', s.games, 1, 50, 1, 'Colors alternate, so an even count gives both models the same number of Whites.')}
        ${num('maxPlies', 'Ply limit', s.maxPlies, 20, 600, 10, 'A game this long is adjudicated on material: five points ahead takes the point, closer is a draw.')}
        ${num('retries', 'Retries before forfeit', s.retries, 0, 10, 1, 'Spent on illegal moves and token-capped replies alike.')}
        ${num('networkRetries', 'Connection retry cap', s.networkRetries, 0, 100, 1, 'Connection failures ridden out before the series parks and waits for you. <code>0</code> keeps retrying, backing off to once a minute — nothing is lost either way.')}
        ${num('maxTokens', 'Max tokens / move', s.maxTokens, 32, MAX_TOKENS, 32, `Both models are told the number. A ceiling, not a target — you are billed for what a model uses, and reasoning effort is what decides that. ${CIRCUITS.map((c) => `${c.maxTokens.toLocaleString('en-US')} = ${c.name}`).join('; ')}.`)}
        <label class="field check">
          <input name="commentary" type="checkbox" ${s.commentary ? 'checked' : ''}/>
          <span>Ask for trash talk with each move</span>
          <span class="field-help">One line of in-character banter alongside each move, shown in the battle log. Costs a few extra tokens per move.</span>
        </label>
        <label class="field check">
          <input name="includePreviousGames" type="checkbox" ${s.includePreviousGames ? 'checked' : ''}/>
          <span>Include previous games' moves and results</span>
          <span class="field-help">Lets a model see how the earlier games of the series went. Grows the prompt, and the cost, with every game played.</span>
        </label>
      </div>
    </fieldset>
    <fieldset class="fieldset">
      <legend>PROMPT</legend>
      ${textarea('promptTemplate', 'Position prompt template', s.promptTemplate)}
      <p class="prompt-help">Available variables: ${PROMPT_VARIABLES.map((v) => `<code>{{${v}}}</code>`).join(' ')}</p>
      <p class="prompt-help">The previous-games variable renders “(not included)” when its match option is turned off.</p>
      <label class="field prompt-field">System instructions (sent separately; White example)<textarea data-system-prompt rows="10" readonly>${escapeHtml(systemPrompt('white', s.commentary, s.maxTokens))}</textarea></label>
      <p class="prompt-help">The color changes with the turn. These fixed JSON response rules are sent before the editable position prompt.</p>
    </fieldset>
    <datalist id="model-list"></datalist>`

  // Render with whatever we already know, then refine once /models answers.
  ;[0, 1].forEach((i) => {
    renderEfforts(i, s.players[i].effort)
    $(`[data-model="${i}"]`).addEventListener('input', () => renderEfforts(i))
  })
  // The preview has to track both inputs it renders — the budget line moves with
  // "Max tokens / move", so a stale preview would misreport what models are told.
  const refreshSystemPrompt = () => {
    const commentary = $<HTMLInputElement>('[name="commentary"]').checked
    const maxTokens = Number($<HTMLInputElement>('[name="maxTokens"]').value) || s.maxTokens
    $<HTMLTextAreaElement>('[data-system-prompt]').value = systemPrompt('white', commentary, maxTokens)
  }
  $<HTMLInputElement>('[name="commentary"]').addEventListener('change', refreshSystemPrompt)
  $<HTMLInputElement>('[name="maxTokens"]').addEventListener('input', refreshSystemPrompt)

  // Ranked eligibility is decided by the settings themselves, so the only honest
  // place to explain it is next to the field that decides it — and it has to
  // track edits, not the values the modal happened to open with.
  const form = $('#settings-form')
  const refreshEligibility = () => renderEligibility(s)
  form.addEventListener('input', refreshEligibility)
  form.addEventListener('change', refreshEligibility)
  refreshEligibility()

  // The catalog has to track the endpoint too, for the same reason: a base URL
  // is something you paste in while the dialog is open.
  form.addEventListener('input', () => scheduleCatalog(s, 400))
  form.addEventListener('change', () => scheduleCatalog(s, 400))

  catalogEndpoint = ''
  scheduleCatalog(s, 0, [s.players[0].effort, s.players[1].effort])
}

/** Marks every field the ranked protocol objects to, and summarises which
 *  circuit the current settings would submit to. */
function renderEligibility(current: Settings) {
  const form = $('#settings-form')
  form.querySelectorAll('.field-verdict').forEach((node) => node.remove())
  form.querySelectorAll('.field.ineligible').forEach((node) => node.classList.remove('ineligible'))

  const { circuit, issues, eligible } = inspectEligibility(readSettings(current))

  for (const issue of issues) {
    const field = form.querySelector(`[name="${issue.field}"]`)?.closest('.field')
    if (!field) continue
    field.classList.add('ineligible')
    const verdict = document.createElement('span')
    verdict.className = 'field-verdict'
    verdict.textContent = issue.reason
    field.appendChild(verdict)
  }

  const banner = $('#eligibility')
  banner.className = `eligibility ${eligible ? 'ok' : 'off'}`
  if (eligible && circuit) {
    banner.textContent = `Ranked: this match can be submitted to the ${circuit.name} (${circuit.maxTokens.toLocaleString('en-US')} tokens per move).`
    return
  }
  const blocked = `${issues.length} setting${issues.length === 1 ? '' : 's'} below ${issues.length === 1 ? 'keeps' : 'keep'} this match out of the standings.`
  banner.textContent = circuit
    ? `Exhibition: your token cap targets the ${circuit.name}, but ${blocked}`
    : `Exhibition: ${blocked} Play it anyway — only submission is affected.`
}


/** Rebuilds one effort dropdown for whatever model id is currently typed. */
function renderEfforts(i: number, preferred?: string) {
  const select = $<HTMLSelectElement>(`[name="p${i}_effort"]`)
  const model = $<HTMLInputElement>(`[data-model="${i}"]`).value.trim()
  const info = known.get(model)
  const current = preferred ?? select.value ?? NO_EFFORT
  // `none` is the provider spelling for disabled reasoning. Keep one label and
  // one persisted value instead of presenting `none` and `off` as if they were
  // different controls.
  const normalisedCurrent = normalizeReasoningEffort(current)

  // Known model: exactly what it accepts, which may be nothing. Unknown model
  // or no catalog at all: a superset, so a custom endpoint or an unlisted
  // variant isn't locked out of choosing one.
  const options = info ? (info.efforts ?? []) : FALLBACK_EFFORTS

  // Off is a different thing from a low effort, and on some models it is the
  // only request they honour: deepseek-v4-flash ignores `low`, a reasoning token
  // budget, and the flat effort field alike — all three spend ~12,700 tokens and
  // return nothing — while off answers in three seconds. Offered whenever the
  // catalog says reasoning is optional, and for unknown models, which are the
  // ones a custom endpoint is most likely to need it for.
  const canDisable = info ? info.canDisable === true : true
  const none = info?.defaultEffort ? `default (${info.defaultEffort})` : 'default'

  select.innerHTML = [
    `<option value="${NO_EFFORT}">${none}</option>`,
    ...options.map((e) => `<option value="${escapeAttr(e)}">${escapeAttr(e)}</option>`),
    ...(canDisable ? [`<option value="${REASONING_OFF}">off (no reasoning)</option>`] : []),
  ].join('')

  const selectable = canDisable ? [...options, REASONING_OFF] : options
  select.value = selectable.includes(normalisedCurrent) ? normalisedCurrent : NO_EFFORT
  const noneOffered = info != null && selectable.length === 0
  select.disabled = noneOffered
  select.title = noneOffered ? `${model} does not expose reasoning effort levels` : ''
}

/** The endpoint the catalog on screen belongs to, and a token for the request in
 *  flight. Both live outside the fetch so a slow answer can be recognised as
 *  stale rather than applied over a newer one. */
let catalogEndpoint = ''
let catalogRun = 0
let catalogTimer: ReturnType<typeof setTimeout> | undefined

/** Refetches the catalog whenever the endpoint in the form changes.
 *
 *  It used to be fetched once, from the settings the modal opened with, so
 *  pasting a new base URL kept the previous provider's catalog on screen: no
 *  autocomplete for the endpoint you just entered, and an effort dropdown
 *  offering levels belonging to a provider you are no longer pointed at. Both
 *  only corrected themselves the next time the modal was opened. */
function scheduleCatalog(initial: Settings, delay: number, preferred?: [string, string]) {
  const baseUrl = $<HTMLInputElement>('[name="baseUrl"]')?.value.trim() || initial.baseUrl
  const apiKey = $<HTMLInputElement>('[name="apiKey"]')?.value.trim() ?? initial.apiKey
  const endpoint = `${baseUrl}\n${apiKey}`
  if (endpoint === catalogEndpoint) return
  catalogEndpoint = endpoint

  // Typing a URL fires an event per keystroke, and every one of them would be a
  // request to a host that is still half-typed.
  clearTimeout(catalogTimer)
  catalogTimer = setTimeout(() => void refreshCatalog(baseUrl, apiKey, ++catalogRun, preferred), delay)
}

async function refreshCatalog(baseUrl: string, apiKey: string, run: number, preferred?: [string, string]) {
  const found = await fetchModels(baseUrl, apiKey)
  // An answer for an endpoint that has since been replaced must not overwrite
  // the current one — /models latency varies by seconds between providers.
  if (run !== catalogRun) return
  known = found

  const list = document.querySelector('#model-list')
  if (list) list.innerHTML = [...known.keys()].sort().map((id) => `<option value="${escapeAttr(id)}"></option>`).join('')
  // The form may have been closed and reopened while this was in flight.
  // `preferred` is the saved effort, and only applies to the catalog this modal
  // opened with; after that the dropdown's own value is the newer intent.
  if (document.querySelector('[data-model="0"]')) [0, 1].forEach((i) => renderEfforts(i, preferred?.[i]))
}

export function readSettings(current: Settings): Settings {
  const form = $('#settings-form')
  const get = (name: string) => form.querySelector<HTMLInputElement>(`[name="${name}"]`)
  const str = (name: string, fallback: string) => get(name)?.value.trim() || fallback
  const raw = (name: string, fallback: string) => get(name)?.value ?? fallback
  const int = (name: string, fallback: number) => {
    const v = Number(get(name)?.value)
    return Number.isFinite(v) ? v : fallback
  }

  const players = [0, 1].map((i) => ({
    label: str(`p${i}_label`, current.players[i].label),
    model: str(`p${i}_model`, current.players[i].model),
    effort: get(`p${i}_effort`)?.value || NO_EFFORT,
    temperature: clamp(int(`p${i}_temperature`, current.players[i].temperature), 0, 2),
  })) as Settings['players']

  return {
    baseUrl: str('baseUrl', DEFAULTS.baseUrl),
    apiKey: get('apiKey')?.value.trim() ?? '',
    players,
    games: clamp(int('games', current.games), 1, 50),
    maxPlies: clamp(int('maxPlies', current.maxPlies), 20, 600),
    retries: clamp(int('retries', current.retries), 0, 10),
    networkRetries: clamp(int('networkRetries', current.networkRetries), 0, 100),
    maxTokens: clamp(int('maxTokens', current.maxTokens), 32, MAX_TOKENS),
    commentary: get('commentary')?.checked ?? true,
    promptTemplate: raw('promptTemplate', DEFAULTS.promptTemplate),
    includePreviousGames: get('includePreviousGames')?.checked ?? true,
    speed: current.speed,
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

function escapeAttr(s: string) {
  return s.replace(/["&<>]/g, (c) => `&#${c.charCodeAt(0)};`)
}

function escapeHtml(s: string) {
  return s.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`)
}
