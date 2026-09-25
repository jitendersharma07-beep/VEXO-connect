-- Ties an order line back to the submission that brought it in.
--
-- Rejecting a submission has to void exactly the lines that submission added and
-- nothing a guest sent thirty seconds later. Without this column the only way to
-- know which lines were whose would be a list of ids inside QrSubmission.payload
-- — unenforced, and wrong the moment a line is merged or re-created.
--
-- RESTRICT on delete, deliberately: an accepted line is part of a real order, and
-- deleting a submission row must never be able to take order history with it.

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "qrSubmissionId" TEXT;

-- CreateIndex
CREATE INDEX "OrderItem_qrSubmissionId_idx" ON "OrderItem"("qrSubmissionId");

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_qrSubmissionId_fkey" FOREIGN KEY ("qrSubmissionId") REFERENCES "QrSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
