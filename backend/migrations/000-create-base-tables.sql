-- Migration 000: Create Base Tables
-- Description: users, documents and exam_questions were originally created by TypeORM
-- synchronize (now disabled), and later migrations ALTER them, so no migration ever
-- created them. This recreates them as they were before migration 002, using the DDL
-- TypeORM generates from the entities minus every column a later migration adds, so the
-- whole chain also works on an empty database.
-- Existing databases are baselined by scripts/migrate.js and never run this file.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TYPE "public"."users_role_enum" AS ENUM('admin', 'teacher', 'student');
CREATE TABLE "users" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "email" character varying NOT NULL,
  "password" character varying NOT NULL,
  "fullName" character varying NOT NULL,
  "role" "public"."users_role_enum" NOT NULL DEFAULT 'student',
  "university" character varying,
  "region" character varying,
  "specialty" character varying,
  "verified" boolean NOT NULL DEFAULT false,
  "avatarUrl" character varying(500),
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"),
  CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id")
);
CREATE INDEX "IDX_97672ac88f789774dd47f7c8be" ON "users" ("email");
CREATE INDEX "IDX_ace513fa30d485cfd25c11a9e4" ON "users" ("role");

CREATE TYPE "public"."documents_status_enum" AS ENUM('pending', 'processing', 'completed', 'failed');
CREATE TABLE "documents" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "userId" uuid NOT NULL,
  "originalFileName" character varying NOT NULL,
  "storageUrl" character varying NOT NULL,
  "status" "public"."documents_status_enum" NOT NULL DEFAULT 'pending',
  "fileSize" integer NOT NULL,
  "mimeType" character varying NOT NULL,
  "ocrResultUrl" character varying,
  "errorMessage" text,
  "title" character varying(500),
  "level" character varying(100),
  "subject" character varying(100),
  "year" integer,
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
  "processedAt" TIMESTAMP,
  CONSTRAINT "PK_ac51aa5181ee2036f5ca482857c" PRIMARY KEY ("id"),
  CONSTRAINT "FK_e300b5c2e3fefa9d6f8a3f25975" FOREIGN KEY ("userId") REFERENCES "users"("id")
);
CREATE INDEX "IDX_e300b5c2e3fefa9d6f8a3f2597" ON "documents" ("userId");
CREATE INDEX "IDX_709389d904fa03bdf5ec84998d" ON "documents" ("status");
CREATE INDEX "IDX_fbc300b58d16ed7b34adf9a8b2" ON "documents" ("year");
CREATE INDEX "IDX_3a1806fe34c5f556df54d96e1d" ON "documents" ("subject");
CREATE INDEX "IDX_4f8540b12d32fcfb55d6d36860" ON "documents" ("level");
CREATE INDEX "IDX_25c68c853fb0c1628d1b700df9" ON "documents" ("status", "createdAt");
CREATE INDEX "IDX_44bb5f2c1b62f87eb8b1fcdbf8" ON "documents" ("userId", "status");

CREATE TABLE "exam_questions" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "question_text" text NOT NULL,
  "question_type" character varying(50) NOT NULL,
  "difficulty" character varying(20),
  "points" numeric(5,2),
  "page_number" integer,
  "options" jsonb,
  "correct_answer" text,
  "topic" character varying(200),
  "bloom_taxonomy" character varying(50),
  "extraction_confidence" numeric(3,2),
  "extracted_at" TIMESTAMP,
  "status" character varying(20) NOT NULL DEFAULT 'pending',
  "reviewed_by" uuid,
  "reviewed_at" TIMESTAMP,
  "embedding" jsonb,
  "document_id" uuid NOT NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT "PK_a214d47c7964cb6356f413dc73c" PRIMARY KEY ("id"),
  CONSTRAINT "FK_d5983be6d6181c6b87008fc9734" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE
);
CREATE INDEX "IDX_ca343df50c74d75df7cc87ecb7" ON "exam_questions" ("status");
CREATE INDEX "IDX_d5983be6d6181c6b87008fc973" ON "exam_questions" ("document_id");
CREATE INDEX "IDX_a70cfd5a9eb488cceeab493b5c" ON "exam_questions" ("difficulty");
CREATE INDEX "IDX_0825f57cc1c53e79671541dec3" ON "exam_questions" ("topic");
