-- Uploaded documents: files kept in private storage, served only through the API.
ALTER TABLE "DocumentRecord" ALTER COLUMN "url" DROP NOT NULL,
  ADD COLUMN "storageKey" TEXT,
  ADD COLUMN "contentType" TEXT,
  ADD COLUMN "sizeBytes" INTEGER,
  ADD COLUMN "sha256" CHAR(64);

CREATE UNIQUE INDEX "DocumentRecord_storageKey_key" ON "DocumentRecord"("storageKey");

-- A document is either a link or an upload, never both or neither; uploads carry their metadata.
ALTER TABLE "DocumentRecord" ADD CONSTRAINT "DocumentRecord_link_or_upload" CHECK (
  ("url" IS NOT NULL AND "storageKey" IS NULL AND "contentType" IS NULL AND "sizeBytes" IS NULL AND "sha256" IS NULL)
  OR ("url" IS NULL AND "storageKey" IS NOT NULL AND "sizeBytes" > 0 AND "sha256" IS NOT NULL
      AND "contentType" IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp'))
);
