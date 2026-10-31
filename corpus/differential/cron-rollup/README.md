# cron-rollup

A correct rollup job on a Cron Trigger: each tick counts the events so far
and upserts one row keyed on `scheduledTime`, so a re-run of a tick after a
crash rewrites its row instead of adding one, then records an event of its
own. The differential test checks the proxied run and the raw run (the
handler called directly with a plain controller, the clock moved to each
tick on both sides) agree on every tick's outcome and on the final
`rollups` table, whose keys are the ticks' virtual times. The same scenario
shows the uniqueness invariant holding under faults at every read and
write.
