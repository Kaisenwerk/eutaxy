/**
 * A live poll kept by an Agent (Cloudflare Agents SDK). Voters connect over
 * WebSockets and cast a vote; each voter is checked against a membership
 * API, the vote is counted in the Agent's state, and every connection is
 * told the new tally. The first vote schedules the poll to close a minute
 * later, when the Agent writes the result into its own table. Run `eutaxy
 * check ./poll.sim.ts` to see two votes arrive at once.
 */

import { Agent, type Connection, routeAgentRequest, type WSMessage } from "agents";

export interface Env {
  readonly POLL: DurableObjectNamespace<Poll>;
}

export interface PollState {
  readonly votes: number;
  readonly closed: boolean;
}

export interface Vote {
  readonly voter: string;
}

export class Poll extends Agent<Env, PollState> {
  override initialState: PollState = { votes: 0, closed: false };

  override async onConnect(connection: Connection): Promise<void> {
    connection.send(JSON.stringify({ type: "tally", votes: this.state.votes }));
  }

  override async onMessage(connection: Connection, message: WSMessage): Promise<void> {
    const vote = JSON.parse(String(message)) as Vote;
    if (this.state.closed) return connection.send(JSON.stringify({ type: "closed" }));
    const votes = this.state.votes;
    if (votes === 0) await this.schedule(60, "close");
    await this.checkMember(vote.voter);
    this.setState({ ...this.state, votes: votes + 1 });
    this.broadcast(JSON.stringify({ type: "tally", votes: votes + 1 }));
  }

  /** The scheduled close: the final tally into the Agent's own table, and to every connection. */
  async close(): Promise<void> {
    this.sql`CREATE TABLE IF NOT EXISTS results (votes INTEGER NOT NULL)`;
    this.sql`INSERT INTO results (votes) VALUES (${this.state.votes})`;
    this.setState({ ...this.state, closed: true });
    this.broadcast(JSON.stringify({ type: "closed", votes: this.state.votes }));
  }

  protected async checkMember(voter: string): Promise<void> {
    const res = await fetch(`https://members.example/members/${voter}`);
    if (!res.ok) throw new Error(`${voter} may not vote (${res.status})`);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (await routeAgentRequest(request, env)) ?? new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
