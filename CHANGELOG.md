# Changelog

## [0.5.0](https://github.com/Kaisenwerk/eutaxy/compare/v0.4.0...v0.5.0) (2026-10-24)


### Features

* **cli:** check --exhaustive and the exhaustive verdict line ([0bef255](https://github.com/Kaisenwerk/eutaxy/commit/0bef25594592820c7015ef989624aceabd217215))
* **cli:** check a scenario's specs ([728c9e1](https://github.com/Kaisenwerk/eutaxy/commit/728c9e19d68636f9fe0f12e5b23e9384df0794d3))
* **cloudflare:** caller retry delays and response deadline on the http drive ([0cf77fe](https://github.com/Kaisenwerk/eutaxy/commit/0cf77fedd56650216cbc2087cbd4e7d75f6d40de))
* **cloudflare:** Durable Object alarms in virtual time ([7802486](https://github.com/Kaisenwerk/eutaxy/commit/78024866c3ce88e0bdeca42684abee0157cf7c3b))
* **cloudflare:** Durable Objects behind a proxied stub boundary ([81cd7aa](https://github.com/Kaisenwerk/eutaxy/commit/81cd7aa3168b0804898ae6b23b76b96013c5417d))
* **cloudflare:** interleave calls into an object at its outbound I/O ([c542f89](https://github.com/Kaisenwerk/eutaxy/commit/c542f893af51b76f05544eba457b02c428a7403f))
* **cloudflare:** refines and d1Read helpers, specs in scenarios ([9299c2b](https://github.com/Kaisenwerk/eutaxy/commit/9299c2b90189661fad02d2d3ebbc72038f964ef5))
* **core:** refines, spec verdicts and scenario specs ([d51308d](https://github.com/Kaisenwerk/eutaxy/commit/d51308dd40215be9d0c67f0144c10e21e299222a))
* **core:** unique state invariant ([c0aa034](https://github.com/Kaisenwerk/eutaxy/commit/c0aa0347045efbabe298410d2b3899ab1cb42ade))
* **engine:** abandon hooks for effects and safer nesting ([f87e4f5](https://github.com/Kaisenwerk/eutaxy/commit/f87e4f5be16dd3be9da851074d558edb0a21e65d))
* **engine:** delayed events, mid-delivery enqueue, bookkeeping invocations ([31d47de](https://github.com/Kaisenwerk/eutaxy/commit/31d47dea2ce0833fd1e59eea1d66785186b230ac))
* **engine:** exhaustive exploration with partial-order reduction ([d6f253d](https://github.com/Kaisenwerk/eutaxy/commit/d6f253d75e34e09dd38d7118dd330382845bffa3))
* **engine:** nested effects and a network guard for platform work ([02beed8](https://github.com/Kaisenwerk/eutaxy/commit/02beed85e061bf445cddf252f76226e9527298a7))
* **engine:** observe core functions as decisions ([ecade52](https://github.com/Kaisenwerk/eutaxy/commit/ecade52523be5927cb6f7a60709e5b671cc2c3e0))
* **engine:** run concurrent invocations interleaved at effects ([af52a95](https://github.com/Kaisenwerk/eutaxy/commit/af52a95889612a032181512dcd0289ba4fdb739f))
* **engine:** turns at hosted code's own effects ([3e40206](https://github.com/Kaisenwerk/eutaxy/commit/3e40206425b2eac38b36bdc2a5ba3505edb52824))
* **prover:** the CHECKED rung ([08daf65](https://github.com/Kaisenwerk/eutaxy/commit/08daf655d7a37cd2a306288e131ef957903251e4))
* **report:** spec verdicts, and replays that observe the core ([d8b8a9b](https://github.com/Kaisenwerk/eutaxy/commit/d8b8a9be47e0d47185b084f53bea51ff608e8307))
* **spec:** SpecIR and a Lemma parser, printer and predicate compiler ([cb8d4fc](https://github.com/Kaisenwerk/eutaxy/commit/cb8d4fc1171a0da2ef9daefbc64416c981a5a4e5))


### Bug Fixes

* **cli:** the help's exit codes include a refuted spec ([5fa4080](https://github.com/Kaisenwerk/eutaxy/commit/5fa408066a3dc5576080f7a58a4601b85d2fa430))
* **cloudflare:** say what a concurrent run explores inside a Durable Object ([e3fb511](https://github.com/Kaisenwerk/eutaxy/commit/e3fb511db622335e23ea6061a5eb2008c520aeb9))
* **engine:** end hung effects, wait for Web Crypto, wake turns on progress ([387b6f6](https://github.com/Kaisenwerk/eutaxy/commit/387b6f62b639a4187c178c1fe3f285ac1e87e7cd))


### Miscellaneous Chores

* release 0.5.0 ([c14ff2c](https://github.com/Kaisenwerk/eutaxy/commit/c14ff2cef91aa2f9ee5c639182e1992f361b77a1))

## 0.4.0 (2026-10-23)


### Features

* initial release ([2ee7747](https://github.com/Kaisenwerk/eutaxy/commit/2ee77470b9a1171a582ffa96a1ef6b6bc48a9aa3))
