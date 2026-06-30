import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getActiveSession } from "@/lib/auth/session";

export async function GET() {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  const rows = await prisma.notification.findMany({
    where: { userId: sess.userId },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      category: true,
      icon: true,
      title: true,
      subtitle: true,
      read: true,
      linkHref: true,
      createdAt: true,
    },
  });
  const items = rows.map((n) => ({
    id: n.id,
    category: n.category,
    icon: n.icon,
    title: n.title,
    subtitle: n.subtitle,
    read: n.read,
    linkHref: n.linkHref,
    createdAt: n.createdAt.toISOString(),
  }));
  return NextResponse.json(items);
}
