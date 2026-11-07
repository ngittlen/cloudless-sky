import {MetricsClient} from '#/analytics/metrics/client'
import {type Events} from '#/analytics/metrics/types'
import {applyMetricsPolicy} from '#/features/cloudless/metrics'

export type {Events as Metrics} from '#/analytics/metrics/types'
export * from '#/analytics/metrics/utils'
export const metrics = applyMetricsPolicy(new MetricsClient<Events>())
