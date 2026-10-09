import { createMemo, createResource, For, Show } from "solid-js"
import type { JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"

// FORK-SEAM: fork-usage-web (data comes from the fork API, empty when the server has no fork telemetry)

function Stat(props: { label: string; value: JSX.Element }) {
  return (
    <div class="flex flex-col gap-1">
      <div class="text-12-regular text-text-weak">{props.label}</div>
      <div class="text-12-medium text-text-strong">{props.value}</div>
    </div>
  )
}

export function SessionForkUsage(props: { sessionID: string | undefined; revision: number }) {
  const language = useLanguage()
  const sdk = useSDK()

  // The revision (message count) changes after every turn, which is when usage changes.
  const [usage] = createResource(
    () => (props.sessionID ? { id: props.sessionID, revision: props.revision } : undefined),
    async (source) => {
      const result = await sdk()
        .client.fork.session.usage({ sessionID: source.id })
        .catch(() => undefined)
      return result?.data
    },
  )

  const usd = createMemo(() => new Intl.NumberFormat(language.intl(), { style: "currency", currency: "USD" }))
  const percent = (value: number) =>
    new Intl.NumberFormat(language.intl(), { style: "percent", maximumFractionDigits: 0 }).format(value)
  const reset = (time: number) =>
    new Date(time).toLocaleString(language.intl(), { weekday: "short", hour: "2-digit", minute: "2-digit" })

  // A session without recorded turns has nothing to show.
  const data = () => (usage()?.turns ? usage() : undefined)

  return (
    <Show when={data()}>
      {(value) => (
        <div class="flex flex-col gap-4">
          <div class="grid grid-cols-1 @[32rem]:grid-cols-2 gap-4">
            <Stat label={language.t("context.fork.cost")} value={usd().format(value().cost)} />
            <Show when={value().cacheHit !== undefined}>
              <Stat label={language.t("context.fork.cacheHit")} value={percent(value().cacheHit ?? 0)} />
            </Show>
            <Show when={value().budget.usd}>
              {(limit) => <Stat label={language.t("context.fork.budget")} value={usd().format(limit())} />}
            </Show>
            <Show when={value().quota?.fiveHour}>
              {(window) => (
                <Stat
                  label={language.t("context.fork.quota.fiveHour")}
                  value={`${percent(window().utilization)} · ${language.t("context.fork.quota.reset", { time: reset(window().reset) })}`}
                />
              )}
            </Show>
            <Show when={value().quota?.sevenDay}>
              {(window) => (
                <Stat
                  label={language.t("context.fork.quota.sevenDay")}
                  value={`${percent(window().utilization)} · ${language.t("context.fork.quota.reset", { time: reset(window().reset) })}`}
                />
              )}
            </Show>
          </div>
          <Show when={value().children.length > 0}>
            <div class="flex flex-col gap-2">
              <div class="text-12-regular text-text-weak">{language.t("context.fork.subagents")}</div>
              <For each={value().children}>
                {(child) => (
                  <div class="flex items-center justify-between gap-4 text-12-regular">
                    <span class="text-text-strong truncate">
                      {child.agent} · {child.model}
                    </span>
                    <span class="text-text-weak shrink-0">{usd().format(child.cost)}</span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      )}
    </Show>
  )
}
