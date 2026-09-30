# ZxZ — Middleware Zendesk ↔ ZapSign

Middleware Node.js que conecta o **Zendesk** à **ZapSign**, criando documentos para assinatura eletrônica a partir de tickets.

```
Ticket Zendesk ──► Webhook ──► Middleware ──► API ZapSign ──► Documento criado
                                                                    │
Ticket atualizado ◄── Middleware ◄── Webhook ZapSign ◄── Assinado ◄─┘
```

**O que acontece na prática:**

1. Ticket criado no Zendesk com a tag `enviar_contrato`
2. Zendesk dispara um webhook com os dados do ticket
3. Middleware recebe os dados, valida, e chama a API da ZapSign
4. ZapSign cria o documento e envia o link por e-mail e WhatsApp
5. Middleware adiciona nota interna no ticket com o link de assinatura e a tag `documento_enviado`
6. Quando o cliente assina, a ZapSign notifica o middleware via webhook
7. Middleware anexa o PDF assinado em nota interna e troca a tag para `documento_assinado`
8. Se o cliente recusar, adiciona nota e troca a tag para `documento_recusado`

---

## Funcionalidades

- **Envio por e-mail e WhatsApp** — automático quando o telefone está preenchido
- **Autenticação** — header `x-webhook-secret` comparado em tempo constante (Zendesk e ZapSign, cada um com seu secret)
- **Rate limiting** — conta só requisições com erro, para não barrar disparos em massa legítimos do Zendesk
- **Proteção contra duplicatas** — não cria novo documento se o ticket já tem `documento_enviado`, `documento_assinado` ou `documento_recusado`; webhooks repetidos da ZapSign são ignorados
- **Tags preservadas** — as tags do ticket são lidas antes de cada atualização e gravadas com `safe_update`; se a leitura falhar, nada é gravado
- **Retentativa automática** — erros temporários (rede, 429, 5xx) são refeitos em 1, 5 e 15 minutos; o alerta no Slack só sai quando desiste
- **Revisão manual quando há dúvida** — se a criação na ZapSign não teve confirmação (timeout/5xx), o job vai para `needs_review` e não é recriado automaticamente, para não mandar dois contratos ao cliente
- **Documento com erro de digitação não trava o envio** — CPF/passaporte inválido segue para a ZapSign com um aviso na nota interna do ticket; só é recusado se vier vazio
- **Audit logs** — JSON estruturado, com CPF/passaporte e e-mail mascarados
- **Alertas via Slack** — notificação em caso de falha definitiva ou revisão manual
- **Suporte a múltiplos signatários** — só marca como assinado quando todos assinaram
- **Encerramento gracioso** — no deploy (SIGTERM), espera os envios em andamento terminarem

## Status dos jobs

Cada ticket recebido vira um arquivo em `JOB_STORAGE_DIR` (padrão `data/zendesk-jobs`).
**No Render, use um Persistent Disk** — sem ele, a fila some a cada deploy.

| Status | Significado | O que fazer |
|---|---|---|
| `pending` | Aguardando envio (ou retentativa agendada) | Nada, o worker processa |
| `document_created` | Documento criado, falta atualizar o ticket | Nada, o worker tenta de novo |
| `failed` | Erro definitivo antes de criar o documento (ex.: modelo não encontrado) | Corrigir a causa; o próximo disparo do trigger recria o job |
| `needs_review` | Documento **pode** existir na ZapSign | Conferir na ZapSign (pasta `/zendesk/`, `external_id` `zendesk-<ticket>`); se não existir, apagar o arquivo do job e disparar de novo |

Obs.: quando `ZAPSIGN_TEMPLATE_ID` está definido, ele tem prioridade sobre o `template_id` enviado pelo Zendesk.

## Testes

```
npm test
```

---

## Links

- [Documentação API ZapSign](https://docs.zapsign.com.br/)
- [Sandbox ZapSign](https://sandbox.app.zapsign.com.br/)
- [Zendesk API](https://developer.zendesk.com/api-reference/)


