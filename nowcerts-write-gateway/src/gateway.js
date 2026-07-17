import { randomUUID } from "node:crypto";
import { canApprove, expectedConfirmation } from "./policy.js";
import { fingerprintProposal, validateProposal } from "./validator.js";

export class NowCertsGateway {
  constructor({ store, mode = "shadow" }) {
    if (mode !== "shadow") {
      throw new Error("Live mode is not implemented. Refusing to start.");
    }
    this.store = store;
    this.mode = mode;
  }

  async prepare(input) {
    const validation = validateProposal(input);
    if (!validation.ok && !validation.proposal) {
      return validation;
    }

    const proposal = validation.proposal;
    const concurrent = await this.store.activeForTarget(proposal.target.database_id);
    const overlappingProposal = concurrent.find((existing) => {
      const existingFields = new Set(existing.proposal.changes.map((change) => change.field));
      return proposal.changes.some((change) => existingFields.has(change.field));
    });
    if (overlappingProposal) {
      proposal.conflicts.push({
        field: "proposal_queue",
        description: `Another active proposal (${overlappingProposal.id}) changes the same record field(s).`,
      });
      validation.status = "CONFLICT";
    } else if (concurrent.length) {
      validation.warnings.push(
        `Another active proposal exists for this record: ${concurrent.map((item) => item.id).join(", ")}.`,
      );
    }
    const now = new Date().toISOString();
    const record = {
      id: randomUUID(),
      created_at: now,
      updated_at: now,
      status: validation.status,
      fingerprint: fingerprintProposal(proposal),
      validation: {
        errors: validation.errors,
        warnings: validation.warnings,
      },
      proposal,
      expected_confirmation:
        validation.status === "READY_FOR_APPROVAL" ? expectedConfirmation(proposal) : null,
      receipt: null,
    };

    await this.store.save(record);
    await this.store.audit({
      event: "proposal_prepared",
      proposal_id: record.id,
      actor: proposal.actor,
      entity_type: proposal.entity_type,
      operation: proposal.operation,
      status: record.status,
      fingerprint: record.fingerprint,
    });
    return record;
  }

  async get(id) {
    return this.store.get(id);
  }

  async approve({ proposal_id: proposalId, approver, confirmation }) {
    const record = await this.store.get(proposalId);
    if (!record) return { ok: false, status: "NOT_FOUND", message: "Proposal not found." };

    if (record.status === "SHADOW_APPROVED") {
      return {
        ok: true,
        status: record.status,
        message: "This proposal was already approved; no duplicate action was taken.",
        receipt: record.receipt,
      };
    }

    if (record.status !== "READY_FOR_APPROVAL") {
      return {
        ok: false,
        status: record.status,
        message: "Only READY_FOR_APPROVAL proposals can be approved.",
      };
    }

    const currentFingerprint = fingerprintProposal(record.proposal);
    if (currentFingerprint !== record.fingerprint) {
      return {
        ok: false,
        status: "STALE",
        message: "Proposal changed after validation. Prepare a new preview.",
      };
    }

    const permission = canApprove({ approver, proposal: record.proposal });
    if (!permission.allowed) {
      await this.store.audit({
        event: "approval_denied",
        proposal_id: proposalId,
        approver,
        reason: permission.reason,
      });
      return { ok: false, status: "FORBIDDEN", message: permission.reason };
    }

    if (confirmation !== record.expected_confirmation) {
      return {
        ok: false,
        status: "CONFIRMATION_REQUIRED",
        message: `Confirmation must exactly match: ${record.expected_confirmation}`,
      };
    }

    const approvedAt = new Date().toISOString();
    record.status = "SHADOW_APPROVED";
    record.updated_at = approvedAt;
    record.receipt = {
      result: "SHADOW_APPROVED",
      proposal_id: proposalId,
      approved_by: approver,
      approved_at: approvedAt,
      written_to_nowcerts: false,
      verification: "No live write attempted; shadow mode is enforced in code.",
      next_action: "Review shadow results before implementing the production connector.",
    };
    await this.store.save(record);
    await this.store.audit({
      event: "shadow_approved",
      proposal_id: proposalId,
      approver,
      fingerprint: record.fingerprint,
    });

    return {
      ok: true,
      status: record.status,
      message: "Approved in shadow mode. Nothing was written to NowCerts.",
      receipt: record.receipt,
    };
  }
}
