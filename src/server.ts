import express, { Request, Response } from "express";
import { CSGO, CSGOGSI } from "csgogsi";
import { OBSWebSocket } from "obs-websocket-js";

type ShapeInsert = "L" | "U";
type ObsTarget = {
  client: OBSWebSocket;
  connectionPromise: Promise<void> | null;
  isConnected: boolean;
  password?: string;
  url: string;
};

const GSI = new CSGOGSI();
const app = express();

const port = 9901;
const regulationMaxRounds = 24;
const overtimeBlockSize = 6;
const regulationEndScoreTotal = 24;
const defaultInsertDurationMs = Number(process.env.SHAPE_INSERT_DURATION_MS ?? 10_000);
const shapeInsertDurationMs = Number.isFinite(defaultInsertDurationMs) && defaultInsertDurationMs > 0
  ? defaultInsertDurationMs
  : 10_000;

const parseCsvEnv = (value: string | undefined): string[] => {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
};

const obsWebSocketUrls = parseCsvEnv(process.env.OBS_WS_URLS ?? process.env.OBS_WS_URL ?? "ws://192.168.1.82:4455");
const obsWebSocketPasswords = parseCsvEnv(process.env.OBS_WS_PASSWORDS ?? process.env.OBS_WS_PASSWORD ?? "");
const encodingScene = process.env.OBS_ENCODING_SCENE ?? "Encoding";
const uShapeScene = process.env.OBS_U_SHAPE_SCENE ?? "Encoding_U_Shape";
const lShapeScene = process.env.OBS_L_SHAPE_SCENE ?? "Encoding_L_Shape";
const obsTargets: ObsTarget[] = obsWebSocketUrls.map((url, index) => ({
  client: new OBSWebSocket(),
  connectionPromise: null,
  isConnected: false,
  password: obsWebSocketPasswords[index] ?? obsWebSocketPasswords[0] ?? undefined,
  url
}));

const regulationSchedule = new Map<number, ShapeInsert>([
  [3, "U"],
  [8, "L"],
  [13, "L"],
  [18, "L"],
  [22, "U"]
]);

let activeSceneReset: NodeJS.Timeout | null = null;
let lastTriggeredRound: number | null = null;
let lastObservedRound = 0;

app.use(express.json({ limit: "1mb" }));

app.post("/gsi/input", async (req: Request, res: Response) => {
  const digested = GSI.digest(req.body);

  if (!digested) {
    res.status(400).json({
      ok: false,
      error: "Unable to digest GSI payload"
    });
    return;
  }

  const currentRound = getCurrentRoundNumber(digested);
  const phase = digested.phase_countdowns.phase;

  try {
    await handleShapeInsert(digested, currentRound);

    res.status(200).json({
      ok: true,
      phase,
      currentRound
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    console.error("Failed to process GSI payload:", message);

    res.status(500).json({
      ok: false,
      error: message
    });
  }
});

const getCurrentRoundNumber = (gameState: CSGO): number => {
  const completedRounds = getCompletedRounds(gameState);

  if (gameState.round?.phase === "over" || gameState.map.phase === "gameover") {
    return completedRounds;
  }

  return completedRounds + 1;
};

const getCompletedRounds = (gameState: CSGO): number => {
  return gameState.map.team_ct.score + gameState.map.team_t.score;
};

const handleShapeInsert = async (gameState: CSGO, currentRound: number): Promise<void> => {
  if (currentRound < lastObservedRound || gameState.phase_countdowns.phase === "warmup") {
    lastTriggeredRound = null;
  }

  lastObservedRound = currentRound;

  if (gameState.phase_countdowns.phase !== "freezetime") {
    return;
  }

  if (lastTriggeredRound === currentRound) {
    return;
  }

  const shapeInsert = getScheduledShapeInsert(currentRound);

  if (!shapeInsert) {
    return;
  }

  lastTriggeredRound = currentRound;

  console.log(`Triggering ${shapeInsert}-shape insert for round ${currentRound}`);

  await triggerObsShapeInsert(shapeInsert, shapeInsertDurationMs);
};

const getScheduledShapeInsert = (currentRound: number): ShapeInsert | undefined => {
  const regulationInsert = regulationSchedule.get(currentRound);

  if (regulationInsert) {
    return regulationInsert;
  }

  if (currentRound <= regulationMaxRounds) {
    return undefined;
  }

  const overtimeRound = ((currentRound - regulationEndScoreTotal - 1) % overtimeBlockSize) + 1;

  if (overtimeRound === 4) {
    return "L";
  }

  return undefined;
};

const getSceneNameForInsert = (shapeInsert: ShapeInsert): string => {
  return shapeInsert === "U" ? uShapeScene : lShapeScene;
};

const ensureObsConnection = async (target: ObsTarget): Promise<void> => {
  if (target.isConnected) {
    return;
  }

  if (!target.connectionPromise) {
    target.connectionPromise = target.client
      .connect(target.url, target.password || undefined)
      .then(() => {
        target.isConnected = true;
        console.log(`Connected to OBS at ${target.url}`);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        target.isConnected = false;
        throw new Error(`Unable to connect to OBS at ${target.url}: ${message}`);
      })
      .finally(() => {
        target.connectionPromise = null;
      });
  }

  await target.connectionPromise;
};

const setProgramSceneOnTarget = async (target: ObsTarget, sceneName: string): Promise<void> => {
  await ensureObsConnection(target);

  try {
    await target.client.call("SetCurrentProgramScene", {
      sceneName
    });
  } catch (error) {
    target.isConnected = false;
    throw error;
  }
};

const setProgramScene = async (sceneName: string): Promise<void> => {
  const results = await Promise.allSettled(
    obsTargets.map((target) => setProgramSceneOnTarget(target, sceneName))
  );

  const failures = results.flatMap((result) => {
    if (result.status === "fulfilled") {
      return [];
    }

    const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
    return [message];
  });

  if (failures.length === obsTargets.length) {
    throw new Error(failures.join(" | "));
  }

  failures.forEach((message) => {
    console.error(`OBS target failed for scene ${sceneName}:`, message);
  });
};

const triggerObsShapeInsert = async (shapeInsert: ShapeInsert, durationMs: number): Promise<void> => {
  const insertScene = getSceneNameForInsert(shapeInsert);

  if (activeSceneReset) {
    clearTimeout(activeSceneReset);
    activeSceneReset = null;
  }

  await setProgramScene(insertScene);

  activeSceneReset = setTimeout(() => {
    void setProgramScene(encodingScene)
      .then(() => {
        console.log(`Returned OBS to ${encodingScene}`);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Failed to return OBS to ${encodingScene}:`, message);
      })
      .finally(() => {
        activeSceneReset = null;
      });
  }, durationMs);
};

app.listen(port, () => {
  console.log(`Listening for POST requests at http://localhost:${port}/gsi/input`);
  console.log(`OBS targets: ${obsTargets.map((target) => target.url).join(", ")}`);
});
