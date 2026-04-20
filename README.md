# cct-shapes

Listens for CS2 GSI events and switches OBS scenes to display shape inserts (L/U) at scheduled rounds.

## Configuration

All configuration is done via environment variables.

| Variable | Default | Description |
|---|---|---|
| `OBS_WS_URLS` | `ws://192.168.1.82:4455` | Comma-separated list of OBS WebSocket URLs |
| `OBS_WS_PASSWORDS` | _(empty)_ | Comma-separated list of OBS WebSocket passwords (matched by index to URLs) |
| `OBS_ENCODING_SCENE` | `Encoding` | Scene to return to after the insert |
| `OBS_U_SHAPE_SCENE` | `Encoding_U_Shape` | Scene name for U-shape inserts |
| `OBS_L_SHAPE_SCENE` | `Encoding_L_Shape` | Scene name for L-shape inserts |
| `SHAPE_INSERT_DURATION_MS` | `10000` | How long (ms) to hold the insert scene before returning to the encoding scene |

## Timing

The insert triggers when `phase_ends_in <= 5` during freezetime — i.e. with 5 seconds left in the freezetime countdown. To change this threshold, edit the value on this line in [src/server.ts](src/server.ts):

```ts
if (phaseEndsIn > 5) {
```

For example, change `5` to `8` to trigger with 8 seconds remaining.

## Insert schedule

Defined in `regulationSchedule` in [src/server.ts](src/server.ts):

| Round | Insert |
|---|---|
| 3 | U |
| 8 | L |
| 13 | L |
| 18 | L |
| 22 | U |

In overtime, an L-shape insert fires on round 4 of every overtime block.
