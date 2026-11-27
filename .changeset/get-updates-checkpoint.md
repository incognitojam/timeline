---
"timeline": minor
---

`get_updates` can keep an agent's place under a name it chooses: pass `checkpoint: "<name>"` and each catch-up starts where that name last finished, so an agent no longer has to carry `id:<n>` between chats. A checkpoint unused for 90 days is cleaned up. A reply that starts from a checkpoint says where the catch-up that moved it began, so a reply lost in transit can be asked for again. Continuing a long catch-up now takes the single `cursor` the reply prints, replacing `until` and `skip`.
