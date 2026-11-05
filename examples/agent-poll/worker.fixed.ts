/**
 * The same poll, with the membership check before the tally is read: the
 * read and the write of the count have no await between them, so a vote
 * that arrives meanwhile reads the count already taken. `eutaxy check
 * ./poll.fixed.sim.ts` reports BOUNDED.
 */

import type { Connection, WSMessage } from "agents";
import { Poll as PlantedPoll, type Vote } from "./worker.ts";

export { default } from "./worker.ts";

export class Poll extends PlantedPoll {
  override async onMessage(connection: Connection, message: WSMessage): Promise<void> {
    const vote = JSON.parse(String(message)) as Vote;
    await this.checkMember(vote.voter);
    if (this.state.closed) return connection.send(JSON.stringify({ type: "closed" }));
    const votes = this.state.votes + 1;
    this.setState({ ...this.state, votes });
    if (votes === 1) await this.schedule(60, "close");
    this.broadcast(JSON.stringify({ type: "tally", votes }));
  }
}
