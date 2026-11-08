import { PauseRequested } from "@arden-hq/loop"

export class RecordedToolPause extends PauseRequested {
  constructor(
    readonly toolCallId: string,
    pause: PauseRequested
  ) {
    super(pause.reason, pause.detail)
  }
}
