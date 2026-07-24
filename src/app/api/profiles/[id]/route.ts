import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/mongodb";
import ProfileModel from "@/lib/models/Profile";
import { adsPower } from "@/lib/adspower/client";
import { withApiErrors } from "@/lib/apiHandler";

function isMissingAdsPowerProfileError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return /not\s*found|not\s*exist|does\s*not\s*exist|no\s*existe|no\s*encontrado|profile.*missing|user.*missing|invalid.*user/i.test(
    message,
  );
}

function isInUseAdsPowerProfileError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return /(being used|in use|other users|en uso|usado)/i.test(message) && /(delete|deleted|cannot|eliminar|borrar)/i.test(message);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export const GET = withApiErrors(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    await dbConnect();
    const profile = await ProfileModel.findById(id);
    if (!profile) return NextResponse.json({ error: "No encontrado" }, { status: 404 });
    return NextResponse.json({ profile });
  },
);

export const DELETE = withApiErrors(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const localOnly = req.nextUrl.searchParams.get("localOnly") === "true";
    await dbConnect();
    const profile = await ProfileModel.findById(id);
    if (!profile) return NextResponse.json({ error: "No encontrado" }, { status: 404 });

    let adsPowerDeleted = false;
    if (!localOnly) {
      try {
        await adsPower.deleteProfiles([profile.adsPowerProfileId]);
        adsPowerDeleted = true;
      } catch (err) {
        if (isMissingAdsPowerProfileError(err)) {
          adsPowerDeleted = false;
        } else if (isInUseAdsPowerProfileError(err)) {
          await adsPower.stopBrowser(profile.adsPowerProfileId).catch(() => undefined);
          await sleep(1200);

          try {
            await adsPower.deleteProfiles([profile.adsPowerProfileId]);
            adsPowerDeleted = true;
          } catch (retryErr) {
            if (isMissingAdsPowerProfileError(retryErr)) {
              adsPowerDeleted = false;
            } else if (isInUseAdsPowerProfileError(retryErr)) {
              return NextResponse.json(
                {
                  error:
                    "AdsPower no permite eliminar este perfil porque sigue en uso. Cierra el perfil en AdsPower o eliminalo solo de esta app.",
                  canDeleteLocal: true,
                },
                { status: 409 },
              );
            } else {
              throw retryErr;
            }
          }
        } else {
          throw err;
        }
      }
    }

    await profile.deleteOne();

    return NextResponse.json({ ok: true, adsPowerDeleted, localOnly });
  },
);
