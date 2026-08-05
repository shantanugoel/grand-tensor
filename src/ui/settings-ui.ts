/** The settings modal: renders a form from the Settings object and reads it back. */

import { listModels } from '../llm'
import { DEFAULTS, type Effort, type Settings } from '../settings'

const EFFORTS: Effort[] = ['default', 'minimal', 'low', 'medium', 'high']

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T

const text = (name: string, label: string, value: string, type = 'text', extra = '') =>
  `<label class="field">${label}<input name="${name}" type="${type}" value="${escapeAttr(value)}" ${extra}/></label>`

const num = (name: string, label: string, value: number, min: number, max: number, step = 1) =>
  `<label class="field">${label}<input name="${name}" type="number" value="${value}" min="${min}" max="${max}" step="${step}"/></label>`

const select = (name: string, label: string, value: string, options: string[]) =>
  `<label class="field">${label}<select name="${name}">${options
    .map((o) => `<option value="${o}" ${o === value ? 'selected' : ''}>${o}</option>`)
    .join('')}</select></label>`

function playerFieldset(i: number, s: Settings) {
  const p = s.players[i]
  return `
    <fieldset class="fieldset">
      <legend>PLAYER ${i + 1}</legend>
      <div class="grid">
        ${text(`p${i}_label`, 'Display name', p.label)}
        ${text(`p${i}_model`, 'Model id', p.model, 'text', 'list="model-list" autocomplete="off"')}
        ${select(`p${i}_effort`, 'Reasoning effort', p.effort, EFFORTS)}
        ${num(`p${i}_temperature`, 'Temperature', p.temperature, 0, 2, 0.1)}
      </div>
    </fieldset>`
}

export function renderSettings(s: Settings) {
  $('#settings-form').innerHTML = `
    <fieldset class="fieldset">
      <legend>ENDPOINT</legend>
      <div class="grid">
        ${text('baseUrl', 'Base URL (OpenAI-compatible)', s.baseUrl)}
        ${text('apiKey', 'API key', s.apiKey, 'password')}
      </div>
    </fieldset>
    ${playerFieldset(0, s)}
    ${playerFieldset(1, s)}
    <fieldset class="fieldset">
      <legend>MATCH</legend>
      <div class="grid">
        ${num('games', 'Games in series', s.games, 1, 50)}
        ${num('maxPlies', 'Ply limit (draw)', s.maxPlies, 20, 600, 10)}
        ${num('retries', 'Retries before forfeit', s.retries, 0, 10)}
        ${num('maxTokens', 'Max tokens / move', s.maxTokens, 32, 32000, 32)}
        <label class="field check">
          <input name="commentary" type="checkbox" ${s.commentary ? 'checked' : ''}/>
          <span>Ask for trash talk with each move</span>
        </label>
      </div>
    </fieldset>
    <datalist id="model-list"></datalist>`

  void refreshModelList(s)
}

async function refreshModelList(s: Settings) {
  const ids = await listModels(s.baseUrl, s.apiKey)
  const list = document.querySelector('#model-list')
  if (list) list.innerHTML = ids.map((id) => `<option value="${escapeAttr(id)}"></option>`).join('')
}

export function readSettings(current: Settings): Settings {
  const form = $('#settings-form')
  const get = (name: string) => form.querySelector<HTMLInputElement>(`[name="${name}"]`)
  const str = (name: string, fallback: string) => get(name)?.value.trim() || fallback
  const int = (name: string, fallback: number) => {
    const v = Number(get(name)?.value)
    return Number.isFinite(v) ? v : fallback
  }

  const players = [0, 1].map((i) => ({
    label: str(`p${i}_label`, current.players[i].label),
    model: str(`p${i}_model`, current.players[i].model),
    effort: (get(`p${i}_effort`)?.value ?? 'default') as Effort,
    temperature: clamp(int(`p${i}_temperature`, current.players[i].temperature), 0, 2),
  })) as Settings['players']

  return {
    baseUrl: str('baseUrl', DEFAULTS.baseUrl),
    apiKey: get('apiKey')?.value.trim() ?? '',
    players,
    games: clamp(int('games', current.games), 1, 50),
    maxPlies: clamp(int('maxPlies', current.maxPlies), 20, 600),
    retries: clamp(int('retries', current.retries), 0, 10),
    maxTokens: clamp(int('maxTokens', current.maxTokens), 32, 32000),
    commentary: get('commentary')?.checked ?? true,
    speed: current.speed,
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

function escapeAttr(s: string) {
  return s.replace(/["&<>]/g, (c) => `&#${c.charCodeAt(0)};`)
}
