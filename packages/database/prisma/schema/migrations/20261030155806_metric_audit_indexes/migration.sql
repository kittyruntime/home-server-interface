-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "MetricSnapshot_timestamp_idx" ON "MetricSnapshot"("timestamp");
