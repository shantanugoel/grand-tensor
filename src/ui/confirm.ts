/** A yes/no modal for the actions that throw work away.
 *
 *  Only a press of the confirm button counts as yes — Escape, the backdrop and
 *  the cancel button all resolve false, and the cancel button takes focus so a
 *  stray Enter can't destroy a live match either. */

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T

export type ConfirmView = {
  title: string
  body: string
  /** Label for the destructive button, e.g. "Reset anyway". */
  confirm: string
  /** Label for the way out, e.g. "Keep playing". */
  cancel: string
}

export class ConfirmModal {
  private el = $('#confirm-modal')
  private titleEl = $('#confirm-title')
  private bodyEl = $('#confirm-body')
  private okBtn = $<HTMLButtonElement>('#btn-confirm-ok')
  private cancelBtn = $<HTMLButtonElement>('#btn-confirm-cancel')

  /** Resolves the promise the caller is parked on. Null when nothing waits. */
  private settle: ((ok: boolean) => void) | null = null

  constructor() {
    this.okBtn.addEventListener('click', () => this.finish(true))
    this.cancelBtn.addEventListener('click', () => this.close())
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close()
    })
    // Escape is handled centrally in main.ts, which closes only the topmost
    // modal — see the note there.
  }

  get isOpen() {
    return !this.el.classList.contains('hidden')
  }

  /** Shows the question and resolves with the answer. A second ask while one is
   *  already on screen is the same button pressed twice: it answers no rather
   *  than stacking a second dialog over the first. */
  ask(view: ConfirmView): Promise<boolean> {
    if (this.settle) return Promise.resolve(false)

    this.titleEl.textContent = view.title
    this.bodyEl.textContent = view.body
    this.okBtn.textContent = view.confirm
    this.cancelBtn.textContent = view.cancel
    this.el.classList.remove('hidden')
    this.cancelBtn.focus()

    return new Promise<boolean>((resolve) => {
      this.settle = resolve
    })
  }

  close() {
    this.finish(false)
  }

  private finish(ok: boolean) {
    if (!this.settle) return
    ;(document.activeElement as HTMLElement | null)?.blur()
    this.el.classList.add('hidden')
    const settle = this.settle
    this.settle = null
    settle(ok)
  }
}
