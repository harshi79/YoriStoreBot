import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "../generated/prisma/client.js";
import type { InventoryStatus } from "../generated/prisma/enums.js";
import { PRODUCT_DELIVERY_PRESETS } from "../utils/credential-parser.js";
import { NotFoundError, ValidationError } from "../utils/errors.js";

export const MAX_INVENTORY_BATCH = 500;
export const MAX_INVENTORY_ITEM_CHARS = 3_500;

export async function listEnabledCategories(prisma: PrismaClient) {
  return prisma.category.findMany({
    where: { enabled: true, deletedAt: null },
    orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
    include: {
      _count: { select: { products: { where: { enabled: true, deletedAt: null } } } },
    },
  });
}

export async function listCategories(prisma: PrismaClient) {
  return prisma.category.findMany({
    where: { deletedAt: null },
    orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
    include: { _count: { select: { products: { where: { deletedAt: null } } } } },
  });
}

export async function createCategory(
  prisma: PrismaClient,
  input: { name: string; description?: string; emoji?: string },
) {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 80) throw new ValidationError("Category names must be 2–80 characters.");
  if ((input.description?.length ?? 0) > 500) throw new ValidationError("Category descriptions are limited to 500 characters.");
  return prisma.category.create({
    data: {
      name,
      description: input.description?.trim() ?? "",
      emoji: input.emoji?.trim() || "◈",
      displayOrder: await prisma.category.count({ where: { deletedAt: null } }),
    },
  });
}

export async function updateCategory(
  prisma: PrismaClient,
  categoryId: string,
  data: { name?: string; description?: string; emoji?: string; enabled?: boolean; displayOrder?: number },
) {
  const update: {
    name?: string;
    description?: string;
    emoji?: string;
    enabled?: boolean;
    displayOrder?: number;
  } = {};
  if (data.name !== undefined) {
    const value = data.name.trim();
    if (value.length < 2 || value.length > 80) throw new ValidationError("Category names must be 2–80 characters.");
    update.name = value;
  }
  if (data.description !== undefined) update.description = data.description.slice(0, 500).trim();
  if (data.emoji !== undefined) update.emoji = data.emoji.trim().slice(0, 16) || "◈";
  if (data.enabled !== undefined) update.enabled = data.enabled;
  if (data.displayOrder !== undefined) {
    if (!Number.isSafeInteger(data.displayOrder) || data.displayOrder < 0 || data.displayOrder > 100_000) {
      throw new ValidationError("Category order must be a positive whole number.");
    }
    update.displayOrder = data.displayOrder;
  }
  try {
    return await prisma.category.update({ where: { id: categoryId, deletedAt: null }, data: update });
  } catch {
    throw new NotFoundError("That category no longer exists.");
  }
}

export async function archiveCategory(prisma: PrismaClient, categoryId: string) {
  return prisma.$transaction(async (tx) => {
    const category = await tx.category.findFirst({ where: { id: categoryId, deletedAt: null } });
    if (!category) throw new NotFoundError("That category no longer exists.");
    const now = new Date();
    await tx.product.updateMany({
      where: { categoryId, deletedAt: null },
      data: { enabled: false, deletedAt: now },
    });
    return tx.category.update({
      where: { id: categoryId },
      data: { enabled: false, deletedAt: now },
    });
  });
}

export async function reorderCategory(prisma: PrismaClient, categoryId: string, direction: -1 | 1) {
  return prisma.$transaction(async (tx) => {
    const categories = await tx.category.findMany({
      where: { deletedAt: null },
      orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
    });
    const index = categories.findIndex((category) => category.id === categoryId);
    if (index < 0) throw new NotFoundError("That category no longer exists.");
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= categories.length) return categories[index];
    const current = categories[index];
    const neighbor = categories[nextIndex];
    if (!current || !neighbor) return current;
    await tx.category.update({ where: { id: current.id }, data: { displayOrder: neighbor.displayOrder } });
    await tx.category.update({ where: { id: neighbor.id }, data: { displayOrder: current.displayOrder } });
    return tx.category.findUniqueOrThrow({ where: { id: current.id } });
  });
}

export async function listProducts(
  prisma: PrismaClient,
  options: { categoryId?: string; includeDisabled?: boolean } = {},
) {
  const where = {
    deletedAt: null,
    ...(options.categoryId ? { categoryId: options.categoryId } : {}),
    ...(options.includeDisabled ? {} : { enabled: true, category: { enabled: true, deletedAt: null } }),
  };
  return prisma.product.findMany({
    where,
    orderBy: [{ featured: "desc" }, { createdAt: "desc" }],
    include: {
      category: true,
      _count: { select: { inventory: { where: { status: "AVAILABLE" } } } },
    },
  });
}

export async function listCategoryProducts(
  prisma: PrismaClient,
  categoryId: string,
  page = 0,
  pageSize = 8,
  includeDisabled = false,
) {
  const where = {
    categoryId,
    deletedAt: null,
    ...(includeDisabled ? {} : { enabled: true, category: { enabled: true, deletedAt: null } }),
  };
  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy: [{ featured: "desc" }, { createdAt: "desc" }],
      skip: Math.max(0, page) * pageSize,
      take: pageSize,
      include: {
        category: true,
        _count: { select: { inventory: { where: { status: "AVAILABLE" } } } },
      },
    }),
    prisma.product.count({ where }),
  ]);
  return { products, total, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function listFeaturedProducts(
  prisma: PrismaClient,
  page = 0,
  pageSize = 8,
) {
  const where = {
    featured: true,
    enabled: true,
    deletedAt: null,
    category: { enabled: true, deletedAt: null },
  };
  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy: [{ createdAt: "desc" }],
      skip: Math.max(0, page) * pageSize,
      take: pageSize,
      include: {
        category: true,
        _count: { select: { inventory: { where: { status: "AVAILABLE" } } } },
      },
    }),
    prisma.product.count({ where }),
  ]);
  return { products, total, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function searchProducts(
  prisma: PrismaClient,
  query: string,
  page = 0,
  pageSize = 8,
) {
  const trimmed = query.trim();
  if (trimmed.length < 1 || trimmed.length > 80) {
    throw new ValidationError("Search query must be 1–80 characters.");
  }
  const where = {
    enabled: true,
    deletedAt: null,
    category: { enabled: true, deletedAt: null },
    OR: [
      { name: { contains: trimmed, mode: "insensitive" as const } },
      { description: { contains: trimmed, mode: "insensitive" as const } },
      { planDetails: { contains: trimmed, mode: "insensitive" as const } },
    ],
  };
  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy: [{ featured: "desc" }, { createdAt: "desc" }],
      skip: Math.max(0, page) * pageSize,
      take: pageSize,
      include: {
        category: true,
        _count: { select: { inventory: { where: { status: "AVAILABLE" } } } },
      },
    }),
    prisma.product.count({ where }),
  ]);
  return { products, total, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function listAdminProducts(prisma: PrismaClient, page = 0, pageSize = 8) {
  const where = { deletedAt: null };
  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy: [{ featured: "desc" }, { createdAt: "desc" }],
      skip: Math.max(0, page) * pageSize,
      take: pageSize,
      include: {
        category: true,
        _count: {
          select: {
            inventory: { where: { status: "AVAILABLE" } },
            stockSubscriptions: true,
          },
        },
      },
    }),
    prisma.product.count({ where }),
  ]);
  return { products, total, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function getProduct(prisma: PrismaClient, productId: string) {
  const product = await prisma.product.findFirst({
    where: { id: productId, deletedAt: null },
    include: {
      category: true,
      _count: {
        select: {
          inventory: { where: { status: "AVAILABLE" } },
          stockSubscriptions: true,
        },
      },
    },
  });
  if (!product) throw new NotFoundError("That product no longer exists.");
  return product;
}

export async function createProduct(
  prisma: PrismaClient,
  input: {
    categoryId: string;
    name: string;
    description?: string;
    planDetails?: string;
    deliveryInstructions?: string;
    warrantyHours?: number;
    mediaFileId?: string | null;
    featured?: boolean;
    isUnlimited?: boolean;
    price: number;
    emoji?: string;
  },
) {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 120) throw new ValidationError("Product names must be 2–120 characters.");
  if (!Number.isSafeInteger(input.price) || input.price < 0 || input.price > 1_000_000_000) {
    throw new ValidationError("Price must be a whole number of credits between 0 and 1,000,000,000.");
  }
  if ((input.description?.length ?? 0) > 2_000) throw new ValidationError("Descriptions are limited to 2,000 characters.");
  if ((input.planDetails?.length ?? 0) > 500) throw new ValidationError("Plan details are limited to 500 characters.");
  if ((input.deliveryInstructions?.length ?? 0) > 2_000) throw new ValidationError("Delivery instructions are limited to 2,000 characters.");
  const warrantyHours = input.warrantyHours ?? 24;
  if (!Number.isSafeInteger(warrantyHours) || warrantyHours < 0 || warrantyHours > 8_760) {
    throw new ValidationError("Warranty hours must be a whole number between 0 and 8,760.");
  }
  const category = await prisma.category.findFirst({ where: { id: input.categoryId, deletedAt: null } });
  if (!category) throw new NotFoundError("Choose an existing category first.");
  return prisma.product.create({
    data: {
      categoryId: input.categoryId,
      name,
      description: input.description?.trim() ?? "",
      planDetails: input.planDetails?.trim() ?? "",
      deliveryInstructions: input.deliveryInstructions?.trim() ?? "",
      warrantyHours,
      mediaFileId: input.mediaFileId ?? null,
      featured: input.featured ?? false,
      isUnlimited: input.isUnlimited ?? false,
      price: input.price,
      emoji: input.emoji?.trim() || "✦",
    },
  });
}

export async function updateProduct(
  prisma: PrismaClient,
  productId: string,
  data: {
    name?: string;
    description?: string;
    planDetails?: string;
    deliveryInstructions?: string;
    warrantyHours?: number;
    mediaFileId?: string | null;
    featured?: boolean;
    isUnlimited?: boolean;
    price?: number;
    emoji?: string;
    enabled?: boolean;
    categoryId?: string;
  },
) {
  const update: {
    name?: string;
    description?: string;
    planDetails?: string;
    deliveryInstructions?: string;
    warrantyHours?: number;
    mediaFileId?: string | null;
    featured?: boolean;
    isUnlimited?: boolean;
    price?: number;
    emoji?: string;
    enabled?: boolean;
    categoryId?: string;
  } = {};
  if (data.name !== undefined) {
    const value = data.name.trim();
    if (value.length < 2 || value.length > 120) throw new ValidationError("Product names must be 2–120 characters.");
    update.name = value;
  }
  if (data.description !== undefined) update.description = data.description.trim().slice(0, 2_000);
  if (data.planDetails !== undefined) update.planDetails = data.planDetails.trim().slice(0, 500);
  if (data.deliveryInstructions !== undefined) update.deliveryInstructions = data.deliveryInstructions.trim().slice(0, 2_000);
  if (data.warrantyHours !== undefined) {
    if (!Number.isSafeInteger(data.warrantyHours) || data.warrantyHours < 0 || data.warrantyHours > 8_760) {
      throw new ValidationError("Warranty hours must be a whole number between 0 and 8,760.");
    }
    update.warrantyHours = data.warrantyHours;
  }
  if (data.mediaFileId !== undefined) update.mediaFileId = data.mediaFileId;
  if (data.featured !== undefined) update.featured = data.featured;
  if (data.isUnlimited !== undefined) update.isUnlimited = data.isUnlimited;
  if (data.price !== undefined) {
    if (!Number.isSafeInteger(data.price) || data.price < 0 || data.price > 1_000_000_000) {
      throw new ValidationError("Price must be a whole number of credits between 0 and 1,000,000,000.");
    }
    update.price = data.price;
  }
  if (data.emoji !== undefined) update.emoji = data.emoji.trim().slice(0, 16) || "✦";
  if (data.enabled !== undefined) update.enabled = data.enabled;
  if (data.categoryId !== undefined) {
    const category = await prisma.category.findFirst({ where: { id: data.categoryId, deletedAt: null } });
    if (!category) throw new NotFoundError("That category no longer exists.");
    update.categoryId = data.categoryId;
  }
  const product = await prisma.product.findFirst({ where: { id: productId, deletedAt: null } });
  if (!product) throw new NotFoundError("That product no longer exists.");
  return prisma.product.update({ where: { id: productId }, data: update });
}

export async function applyProductPreset(prisma: PrismaClient, productId: string, presetKey: string) {
  const preset = PRODUCT_DELIVERY_PRESETS[presetKey];
  if (!preset) throw new ValidationError("Unknown product preset.");
  return updateProduct(prisma, productId, {
    planDetails: preset.planDetails,
    warrantyHours: preset.warrantyHours,
    deliveryInstructions: preset.deliveryInstructions,
  });
}

export async function cloneProduct(prisma: PrismaClient, productId: string) {
  const source = await prisma.product.findFirst({ where: { id: productId, deletedAt: null } });
  if (!source) throw new NotFoundError("That product no longer exists.");

  let candidateName = `${source.name.slice(0, 105)} (Copy)`;
  let suffix = 2;
  while (await prisma.product.findFirst({ where: { categoryId: source.categoryId, name: candidateName } })) {
    candidateName = `${source.name.slice(0, 100)} (Copy ${suffix++})`;
  }

  return prisma.product.create({
    data: {
      categoryId: source.categoryId,
      name: candidateName,
      description: source.description,
      planDetails: source.planDetails,
      deliveryInstructions: source.deliveryInstructions,
      warrantyHours: source.warrantyHours,
      mediaFileId: source.mediaFileId,
      featured: false,
      isUnlimited: source.isUnlimited,
      price: source.price,
      emoji: source.emoji,
      enabled: false,
    },
  });
}

export async function archiveProduct(prisma: PrismaClient, productId: string) {
  const product = await prisma.product.findFirst({ where: { id: productId, deletedAt: null } });
  if (!product) throw new NotFoundError("That product no longer exists.");
  return prisma.product.update({
    where: { id: productId },
    data: { enabled: false, deletedAt: new Date() },
  });
}

export async function addInventoryItems(
  prisma: PrismaClient,
  productId: string,
  payloads: string[],
) {
  const submitted = payloads.map((payload) => payload.trim()).filter(Boolean);
  if (submitted.length === 0) throw new ValidationError("Send at least one non-empty inventory item.");
  if (submitted.length > MAX_INVENTORY_BATCH) {
    throw new ValidationError(`A stock batch is limited to ${MAX_INVENTORY_BATCH} lines at a time.`);
  }
  if (submitted.some((payload) => payload.length > MAX_INVENTORY_ITEM_CHARS)) {
    throw new ValidationError(`Each inventory item must be ${MAX_INVENTORY_ITEM_CHARS.toLocaleString()} characters or less so it fits in a Telegram delivery.`);
  }
  const uniqueByHash = new Map<string, string>();
  for (const payload of submitted) {
    const hash = createHash("sha256").update(payload).digest("hex");
    if (!uniqueByHash.has(hash)) uniqueByHash.set(hash, payload);
  }
  const product = await prisma.product.findFirst({ where: { id: productId, deletedAt: null } });
  if (!product) throw new NotFoundError("That product no longer exists.");
  const inserted = await prisma.inventoryItem.createMany({
    data: [...uniqueByHash].map(([payloadHash, payload]) => ({
      id: randomUUID(),
      productId,
      payload,
      payloadHash,
    })),
    skipDuplicates: true,
  });
  return { inserted: inserted.count, duplicates: submitted.length - inserted.count };
}

export async function listAvailableInventory(
  prisma: PrismaClient,
  productId?: string,
  skip = 0,
  take = 10,
) {
  return prisma.inventoryItem.findMany({
    where: { status: "AVAILABLE", ...(productId ? { productId } : {}) },
    orderBy: { createdAt: "asc" },
    skip,
    take,
    select: {
      id: true,
      productId: true,
      createdAt: true,
      product: { select: { name: true, emoji: true } },
    },
  });
}

export async function getAvailableInventoryItem(prisma: PrismaClient, itemId: string) {
  const item = await prisma.inventoryItem.findFirst({
    where: { id: itemId, status: "AVAILABLE" },
    include: { product: { select: { id: true, name: true, emoji: true } } },
  });
  if (!item) throw new NotFoundError("That available stock item no longer exists.");
  return item;
}

export async function listAllAvailablePayloads(prisma: PrismaClient, productId: string) {
  const product = await prisma.product.findFirst({ where: { id: productId, deletedAt: null } });
  if (!product) throw new NotFoundError("That product no longer exists.");
  const items = await prisma.inventoryItem.findMany({
    where: { productId, status: "AVAILABLE" },
    orderBy: { createdAt: "asc" },
    select: { payload: true },
  });
  return { product, payloads: items.map((item) => item.payload) };
}

export async function clearAvailableInventory(prisma: PrismaClient, productId: string) {
  const product = await prisma.product.findFirst({ where: { id: productId, deletedAt: null } });
  if (!product) throw new NotFoundError("That product no longer exists.");
  const result = await prisma.inventoryItem.updateMany({
    where: { productId, status: "AVAILABLE" },
    data: { status: "REMOVED" as InventoryStatus },
  });
  return { removed: result.count };
}

export async function removeInventoryItem(prisma: PrismaClient, itemId: string) {
  const changed = await prisma.inventoryItem.updateMany({
    where: { id: itemId, status: "AVAILABLE" },
    data: { status: "REMOVED" as InventoryStatus },
  });
  if (!changed.count) throw new NotFoundError("That available stock item no longer exists.");
}

export async function countAvailableInventory(prisma: PrismaClient, productId?: string) {
  return prisma.inventoryItem.count({
    where: { status: "AVAILABLE", ...(productId ? { productId } : {}) },
  });
}

export async function isSubscribedToStock(
  prisma: PrismaClient,
  userId: string,
  productId: string,
): Promise<boolean> {
  const sub = await prisma.stockSubscription.findUnique({
    where: { userId_productId: { userId, productId } },
  });
  return Boolean(sub);
}

export async function toggleStockSubscription(
  prisma: PrismaClient,
  userId: string,
  productId: string,
): Promise<{ subscribed: boolean }> {
  const product = await prisma.product.findFirst({ where: { id: productId, deletedAt: null } });
  if (!product) throw new NotFoundError("That product no longer exists.");
  const existing = await prisma.stockSubscription.findUnique({
    where: { userId_productId: { userId, productId } },
  });
  if (existing) {
    await prisma.stockSubscription.delete({ where: { id: existing.id } });
    return { subscribed: false };
  }
  await prisma.stockSubscription.create({
    data: { id: randomUUID(), userId, productId },
  });
  return { subscribed: true };
}

export async function consumeStockSubscribers(prisma: PrismaClient, productId: string) {
  return prisma.$transaction(async (tx) => {
    const subs = await tx.stockSubscription.findMany({
      where: { productId },
      include: { user: { select: { id: true, telegramId: true, isBlocked: true } } },
    });
    if (subs.length > 0) {
      await tx.stockSubscription.deleteMany({ where: { productId } });
    }
    return subs
      .map((sub) => sub.user)
      .filter((user) => !user.isBlocked);
  });
}
