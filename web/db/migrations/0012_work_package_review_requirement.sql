ALTER TABLE "work_packages" ADD COLUMN "review_requirement" text DEFAULT 'both' NOT NULL;
ALTER TABLE "work_packages" ADD CONSTRAINT "work_packages_review_requirement_chk" CHECK ("review_requirement" IN ('none', 'qa_only', 'reviewer_only', 'both'));
