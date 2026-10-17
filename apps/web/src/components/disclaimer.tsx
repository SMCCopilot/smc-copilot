/** Full disclaimer text. Shown at onboarding and (F4) in Settings. Needs counsel review before public launch. */
export function DisclaimerText() {
  return (
    <div className="space-y-2 text-sm text-muted">
      <p>
        SMC Copilot gives educational analysis of market structure. It is not financial, investment
        or trading advice, and nothing it shows is a recommendation to open or close a position.
      </p>
      <p>
        Scenarios are possibilities drawn from rules, not predictions. Past results do not indicate
        future results, and the latest backtest found no proven edge. Trading, especially with
        leverage, can lose more than you put in.
      </p>
      <p>
        You stay in control. The app never places trades. Logging a trade needs your own tap on
        Confirm. Voice and chat can never confirm anything.
      </p>
      <p>
        Screen images and audio are processed on your device or in memory and are not stored. Raw
        prices are shown only where the data licence allows it.
      </p>
    </div>
  );
}
