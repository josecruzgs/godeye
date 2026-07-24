import type { Types } from "mongoose";
import CampaignModel from "@/lib/models/Campaign";
import TaskModel from "@/lib/models/Task";

export const CAMPAIGN_STATUSES = [
  "pending",
  "queued",
  "running",
  "paused",
  "success",
  "failed",
  "partial",
  "cancelled",
  "empty",
];

export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export type TaskStatusCounts = Record<string, number>;

const TYPE_LABELS: Record<string, string> = {
  like: "Likes",
  comment: "Comentarios",
  post: "Publicaciones",
  warmup: "Warmup",
  scrape: "Scrapping",
  custom: "Auto Profile",
  login: "Login",
};

export function readCampaignName(body: Record<string, unknown>, type: string, fallbackPrefix: string) {
  const raw = typeof body.campaignName === "string" ? body.campaignName.trim() : "";
  if (raw) return raw;

  const label = TYPE_LABELS[type] ?? (fallbackPrefix || "Campaña");
  const timestamp = new Date().toLocaleString("es-MX", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${label} ${timestamp}`;
}

export function computeCampaignStatus(counts: TaskStatusCounts): CampaignStatus {
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (total === 0) return "empty";
  if ((counts.running ?? 0) > 0) return "running";
  // Pausada tiene prioridad sobre queued/pending: al pausar se mueven ahí
  // los pendientes/en cola, así que si queda algo en paused es porque el
  // usuario detuvo la campaña a propósito.
  if ((counts.paused ?? 0) > 0) return "paused";
  if ((counts.queued ?? 0) > 0) return "queued";
  if ((counts.pending ?? 0) > 0) return "pending";
  if ((counts.failed ?? 0) > 0 && (counts.success ?? 0) > 0) return "partial";
  if ((counts.failed ?? 0) > 0) return "failed";
  if ((counts.cancelled ?? 0) === total) return "cancelled";
  return "success";
}

export function normalizeStatusCounts(counts: TaskStatusCounts = {}) {
  return {
    pending: counts.pending ?? 0,
    queued: counts.queued ?? 0,
    running: counts.running ?? 0,
    paused: counts.paused ?? 0,
    success: counts.success ?? 0,
    failed: counts.failed ?? 0,
    cancelled: counts.cancelled ?? 0,
  };
}

export function totalFromCounts(counts: TaskStatusCounts) {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

export async function createCampaignWithTasks({
  name,
  type,
  autoRun,
  docs,
}: {
  name: string;
  type: string;
  autoRun: boolean;
  docs: Record<string, unknown>[];
}) {
  const campaign = await CampaignModel.create({
    name,
    type,
    autoRun,
    taskCount: docs.length,
  });

  try {
    const tasks = await TaskModel.insertMany(docs.map((doc) => ({ ...doc, campaignId: campaign._id })));
    return { campaign, tasks };
  } catch (err) {
    await CampaignModel.deleteOne({ _id: campaign._id }).catch(() => {});
    throw err;
  }
}

export function makeCampaignSummary({
  campaign,
  counts,
}: {
  campaign: {
    _id: Types.ObjectId | string;
    name: string;
    type: string;
    autoRun?: boolean;
    taskCount?: number;
    createdAt?: Date;
    updatedAt?: Date;
  };
  counts: TaskStatusCounts;
}) {
  const normalizedCounts = normalizeStatusCounts(counts);
  const total = totalFromCounts(normalizedCounts);
  return {
    _id: campaign._id,
    name: campaign.name,
    type: campaign.type,
    autoRun: Boolean(campaign.autoRun),
    taskCount: total || campaign.taskCount || 0,
    status: computeCampaignStatus(normalizedCounts),
    counts: normalizedCounts,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
  };
}
