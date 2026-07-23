"use client";

/**
 * Shared "just-submitted → show ApprovalCard inline" panel used by every
 * console-style resource-creation page (VPC, EC2, S3, Peering). Keeps the
 * copy consistent across pages and centralizes the "New X" reset button.
 */
import { Block, Btn } from "@/components/ui";
import { ApprovalCard } from "@/components/domain/ApprovalCard";

export function InlineApprovalResult({
  slug,
  approvalId,
  repoFullName,
  repoPath,
  onReset,
  resetLabel = "New",
}: {
  slug: string;
  approvalId: string;
  repoFullName: string;
  repoPath: string;
  onReset: () => void;
  resetLabel?: string;
}) {
  return (
    <div className="col gap-4">
      <Block>
        <Block.Header>
          <Block.Title sub={`Files committed to ${repoFullName}/${repoPath}. Approve below to run terraform apply.`}>
            Submitted — pending approval
          </Block.Title>
        </Block.Header>
      </Block>
      <ApprovalCard slug={slug} approvalId={approvalId} />
      <div className="row gap-2">
        <Btn variant="outline" onClick={onReset}>
          {resetLabel}
        </Btn>
      </div>
    </div>
  );
}
