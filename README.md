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
5. Middleware adiciona nota interna no ticket com o link de assinatura
6. Quando o cliente assina, a ZapSign notifica o middleware via webhook
7. Middleware adiciona nota interna e tag `contrato_assinado` no ticket
8. Se o cliente recusar, adiciona nota e tag `contrato_recusado`

---

## Funcionalidades

- **Envio por e-mail e WhatsApp** — automático quando o telefone está preenchido
- **Rate limiting** — 50 req/15min global, 20 req/min no webhook
- **Autenticação segura** — webhook secret (Zendesk) e HMAC SHA-256 com raw body (ZapSign)
- **Proteção contra duplicatas** — evita criar múltiplos documentos se o trigger disparar repetido
- **Audit logs** — logs estruturados em JSON com CPF mascarado
- **Validação de dados** — CPF com dígitos verificadores, e-mail, campos obrigatórios
- **Alertas via Slack** — notificação automática em caso de falhas
- **Suporte a múltiplos signatários** — só marca como assinado quando todos assinaram
- **Documento recusado** — detecta recusa e adiciona tag + nota no ticket
  
---

## Links

- [Documentação API ZapSign](https://docs.zapsign.com.br/)
- [Sandbox ZapSign](https://sandbox.app.zapsign.com.br/)
- [Zendesk API](https://developer.zendesk.com/api-reference/)


