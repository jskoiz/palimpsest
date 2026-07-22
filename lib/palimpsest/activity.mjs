export function serializeRecentJobPayload(row) {
  const region =
    row.regionX == null || row.regionY == null
      ? null
      : {
          x: Number(row.regionX),
          y: Number(row.regionY),
          width: Number(row.regionWidth),
          height: Number(row.regionHeight),
        };
  const displaySummary = region
    ? `region ${region.x},${region.y} · ${region.width}×${region.height}`
    : row.kind === "revert"
      ? "full-canvas restore"
      : "canvas contribution";
  return {
    id: row.jobId,
    kind: row.kind,
    author: row.author,
    state: row.state,
    region,
    reservationActive: Boolean(row.reservationActive),
    prompt: row.state === "succeeded" ? row.prompt : null,
    displaySummary,
    error: row.errorCode
      ? { code: row.errorCode, message: row.publicErrorMessage }
      : null,
    requestId: row.requestId,
    submittedAt: new Date(Number(row.createdAt)).toISOString(),
    updatedAt: new Date(Number(row.updatedAt)).toISOString(),
    startedAt: row.startedAt == null ? null : new Date(Number(row.startedAt)).toISOString(),
    completedAt:
      row.completedAt == null ? null : new Date(Number(row.completedAt)).toISOString(),
    retryable: Boolean(row.retryable),
  };
}
