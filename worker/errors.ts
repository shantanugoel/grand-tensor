/** A request the caller can fix: a malformed body, a config that isn't ranked,
 *  a PGN that doesn't replay. Anything else is ours.
 *
 *  This used to be decided by running a regex over the message text, which meant
 *  the classification drifted every time a message was reworded — and reported
 *  outages as 400s whenever the wording happened to contain a matching word
 *  ("Model registry is temporarily unavailable" matched /model/). The type says
 *  it instead, so the message is free to say whatever is clearest. */
export class ClientError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClientError'
  }
}
