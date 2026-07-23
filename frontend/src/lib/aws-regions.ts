/**
 * Single source of truth for AWS region lists used across pickers.
 *
 * Previously each surface (Network page tabs, chat wizard boxes, the EC2
 * playbook prompt) hardcoded its own array — the Network page had 7, the
 * chat wizard boxes had 16, the EC2 playbook had 30 — and users hit
 * regions in one place that they couldn't hit in another. Everything now
 * imports from here.
 *
 * Ordering follows AWS's own "region distance from the primary US regions"
 * convention: the busiest US regions first, then the rest geographically.
 * Extend when AWS adds a new region.
 */

export const AWS_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "ca-central-1",
  "ca-west-1",
  "sa-east-1",
  "mx-central-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-central-1",
  "eu-central-2",
  "eu-north-1",
  "eu-south-1",
  "eu-south-2",
  "me-central-1",
  "me-south-1",
  "il-central-1",
  "af-south-1",
  "ap-south-1",
  "ap-south-2",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-southeast-3",
  "ap-southeast-4",
  "ap-southeast-5",
  "ap-southeast-7",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "ap-east-1",
] as const;

export type AwsRegion = (typeof AWS_REGIONS)[number];
