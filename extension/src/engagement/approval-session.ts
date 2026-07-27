export type EngagementStep = "comment" | "like" | "mutual_neighbor";

export interface EngagementApprovalDetails {
  comment: string;
  neighborMessage?: string;
  sourceUrl: string;
  steps: readonly EngagementStep[];
  title: string;
}

export interface EngagementApprovalToken {
  readonly details: Readonly<EngagementApprovalDetails>;
  readonly id: string;
}

export class EngagementApprovalSession {
  readonly #pending = new Map<string, EngagementApprovalToken>();
  readonly #randomId: () => string;

  constructor(randomId: () => string = () => crypto.randomUUID()) {
    this.#randomId = randomId;
  }

  issue(details: EngagementApprovalDetails): EngagementApprovalToken {
    const token: EngagementApprovalToken = Object.freeze({
      details: Object.freeze({
        ...details,
        steps: Object.freeze([...details.steps]),
      }),
      id: this.#randomId(),
    });
    this.#pending.set(token.id, token);
    return token;
  }

  consume(id: string): EngagementApprovalToken | null {
    const token = this.#pending.get(id) ?? null;
    this.#pending.delete(id);
    return token;
  }

  revokeAll(): void {
    this.#pending.clear();
  }
}
