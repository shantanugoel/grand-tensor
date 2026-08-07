/** The strip that stands in for the dock while a match video renders.
 *
 *  The replay plays out on the live arena, so the panels around it are showing
 *  the finished series' numbers over a board that has jumped back to move one.
 *  `body.exporting` fades them out; this strip is what's left, and it owns the
 *  only way to stop the export. */

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T

export class VideoProgress {
  private el = $('#video-progress')
  private fill = $('#vp-fill')
  private label = $('#vp-label')
  private cancelBtn = $<HTMLButtonElement>('#btn-video-cancel')
  private onCancel: (() => void) | null = null

  constructor() {
    this.cancelBtn.addEventListener('click', () => this.onCancel?.())
  }

  open(onCancel: () => void) {
    this.onCancel = onCancel
    this.cancelBtn.disabled = false
    this.update(0, 'Preparing…')
    this.el.classList.remove('hidden')
    document.body.classList.add('exporting')
  }

  update(fraction: number, label: string) {
    this.fill.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`
    this.label.textContent = label
  }

  /** The encoder still has to flush after the last frame, so cancelling darkens
   *  the button rather than closing the strip — otherwise the UI is back before
   *  the file is. */
  finishing(text: string) {
    this.onCancel = null
    this.cancelBtn.disabled = true
    this.label.textContent = text
  }

  close() {
    this.onCancel = null
    this.el.classList.add('hidden')
    document.body.classList.remove('exporting')
  }
}
