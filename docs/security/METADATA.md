# Metadados, serviços e retenção

| Componente | Dados visíveis | Conteúdo protegido |
|---|---|---|
| Annoy Global | Acesso à conta, hash/identificador de email, eventos de login/emissão, IP na conexão, tamanhos e versão do cofre cifrado, registro público da instância | Não recebe histórico MLS, folhas privadas ou lista pessoal legível do cofre novo |
| Instância | IDs independentes, membros/cargos/canais/permissões, dispositivos/chaves públicas, época/roster, remetente/destinatário de Welcome, horários, validade, tamanhos/IDs de blobs, IP na conexão | Não recebe texto, nomes/MIME sensíveis de anexos MLS ou fileKeys |
| Delivery/SQLite/backups da instância | Ciphertext de mensagens/arquivos e metadados; texto claro histórico enquanto não expurgado | Ciphertext isolado não inclui chaves necessárias para abrir conteúdo novo |
| SFU/STUN/TURN | IP, codecs, roteamento, horários e mídia legada | Nesta implementação mídia NÃO tem E2EE perante SFU |
| Electron main/Rust | Chaves e texto durante uso autorizado | Não isolados de um SO ou processo main comprometido |
| Renderer Annoy | Texto apresentado e bytes de anexo autorizado | Não recebe fileKey, signer MLS, snapshot ou raiz privada via IPC |
| Serviços externos | IP, cookies próprios, URLs, conteúdo fornecido ao serviço | São domínios de confiança distintos; não possuem as chaves MLS |
| SO e backups do usuário | Cofre cifrado, keychain, notificações genéricas E2EE, dumps/swap possíveis | Cofre desbloqueado e memória exigem confiança no dispositivo |

Retenção implementada: sessões bootstrap 5 min e vinculadas 24 h; desafios 2 min; KeyPackages envelhecidos 7 dias; blobs não vinculados 24 h; ciphertext e registros temporários pelo expiresAt, com limpeza periódica (servidor cerca de 30 s, cliente desbloqueado cerca de 1 s); permanentes sem expiração automática. Pins e tombstones permanentes são mantidos para detectar downgrade e não desfazer exclusões no cofre atual. Filas/cursors/antirreplay são metadados de operação, não anonimização.

Logs padrão do servidor retiram query strings, headers, body e IP do registro da requisição; logs de erro não carregam payload. Email de recuperação não é impresso em produção. Não interpretar isso como política automática do reverse proxy, provedor, SO, Git, Discord ou Cloudflare. O operador deve limitar retenção dessas camadas e documentá-la. Os testes não comprovam ausência universal de segredos em todos os ambientes.

Backups legados de migração contêm texto claro por necessidade de recuperação e não são eliminados automaticamente. Definir prazo de retenção e acesso restrito, testar cópias cifradas locais e então descartar cópias legíveis sob controle do sistema. Não apagar permanentes sem política explícita. Não coletar telemetria de conteúdo; auditoria deve conferir também relatórios de erro e serviços terceiros.
