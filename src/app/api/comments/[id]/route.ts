import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/mongodb";
import CommentModel from "@/lib/models/Comment";
import { withApiErrors } from "@/lib/apiHandler";

export const DELETE = withApiErrors(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    await dbConnect();
    await CommentModel.findByIdAndDelete(id);
    return NextResponse.json({ ok: true });
  },
);
