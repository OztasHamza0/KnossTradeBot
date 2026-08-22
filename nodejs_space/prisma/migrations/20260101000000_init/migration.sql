-- CreateTable
CREATE TABLE "chat_history" (
    "id" SERIAL NOT NULL,
    "chat_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_instructions" (
    "id" SERIAL NOT NULL,
    "chat_id" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_instructions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sent_signals" (
    "id" SERIAL NOT NULL,
    "chat_id" TEXT NOT NULL,
    "pair" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "entry_price" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sent_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "active_chats" (
    "id" SERIAL NOT NULL,
    "chat_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "active_chats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_state" (
    "id" SERIAL NOT NULL,
    "chat_id" TEXT NOT NULL,
    "balance_usdt" DOUBLE PRECISION,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_history_chat_id_created_at_idx" ON "chat_history"("chat_id", "created_at");

-- CreateIndex
CREATE INDEX "user_instructions_chat_id_idx" ON "user_instructions"("chat_id");

-- CreateIndex
CREATE INDEX "sent_signals_chat_id_pair_direction_created_at_idx" ON "sent_signals"("chat_id", "pair", "direction", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "active_chats_chat_id_key" ON "active_chats"("chat_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_state_chat_id_key" ON "user_state"("chat_id");

