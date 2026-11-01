# Riscos restantes e condições de fechamento

Classificação interna para priorizar revisão, não resultado de pentest independente.

| Prioridade | Risco conhecido | Condição para fechar |
|---|---|---|
| Alta de mídia | Crate `sframe` 2.1.0 e adaptador WebAssembly sem auditoria | Auditoria do crate/adaptador/worker antes de release |
| Média de mídia | Chaves de época no worker do renderer; SFrame sem autenticação individual do emissor; dispositivo que saiu conhece a época até o commit de remoção; metadados de quadro VP8 legíveis | Documentados em MEDIA-KEYS; avaliar isolamento adicional e rotação imediata por timer |
| Alta | Annoy e backport dos providers não foram auditados independentemente | Revisar core/provider/delta/IPC/storage/políticas e reproduzir FS/PCS antes de afirmar segurança do produto |
| Alta | Verificador Ed25519 implementado/testado, mas sem chave confiável de produção; cadeia de instaladores do SO não validada | Fornecer chave pública sob controle do projeto e certificado quando disponível; testar instalação real e revalidação nas duas plataformas. Artefato adulterado/assinante errado já têm testes sintéticos; instalação sem chave falha fechada |
| Alta | Frontend web Global adulterado pode capturar cofre aberto no navegador | Separar credenciais de distribuição/backend e validar o desktop assinado; não equiparar armazenamento cifrado a proteção contra JavaScript malicioso entregue ao usuário |
| Alta | Primeira identidade é TOFU; diretório malicioso antes de pins/verificação | Comparação de código fora de banda e futura avaliação de transparência de chaves; testar servidor ativamente malicioso com vários clientes |
| Alta | Escrow Global antigo pode ter revelado identidades e cofres anteriores | Rotação cliente, revogação/revisão de identidades afetadas e plano operacional para cópias antigas; sem garantia retroativa |
| Alta | Imagem completa antiga de cliente pode conter chaves/cópias apagadas | Excluir temporários/estados dos backups do app já implementado; controlar backups externos e explicar o limite ao usuário |
| Média de aceitação | Windows executado só em VM: hardware físico, instalador e atualização assinada não ensaiados | Rodar workflow em revisão correspondente e testes reais em Windows; registrar artefatos e falhas |
| Média | Cliente muito atrasado pode bloquear em commits antigos envolvendo certificados agora revogados | Testar recuperação/reingresso e desenhar transição autenticada sem liberar chaves revogadas |
| Média | Proprietário MLS indisponível e autorização de novos membros | Exercitar handover, perda total de dispositivos e recuperação em grupos grandes; não oferecer bypass administrativo |
| Média | Envelope do cofre Global possibilita tentativa offline de senha, com o custo PBKDF2 cliente | Senhas fortes e revisão futura de KDF/versionamento. Pepper do autenticador não protege esse envelope; não alegar que vazamento de banco impede toda tentativa de senha |
| Média | 15 avisos npm moderados na cadeia minimatch do empacotador | Atualização compatível validada ou correção upstream. Não forçar API v11 em consumidores v3 nem aceitar downgrade do empacotador sugerido por npm audit fix |
| Média | proc-macro-error2 2.0.1 opcional não mantido no lock | Confirmar árvore de features e substituir quando upstream permitir; auditar novamente antes da build |
| Média | DoS distribuído/armazenamento, grupos e arquivos grandes | Ensaios de carga reais e limites operacionais; KDF/quotas/rate limits não garantem resistência a todo ataque |
| Média | ASVS 5 apenas orienta a matriz, sem avaliação integral | Avaliação requisito a requisito, teste manual e pentest independente do backend |
| Média | Cleanup em SSD, durabilidade Windows e falha pós-commit | Fault injection, recuperação em filesystem real e revisão operacional; não prometer sobrescrita física |
| Média de distribuição | Fuses restritivos e conteúdo do pacote foram verificados em Linux, mas a GUI/instalação desse executável e Windows ainda não foram exercitados | Testar builds distribuídos em perfis descartáveis, CAs de feeds, logins externos e assinatura do SO; ver LINUX-PACKAGE. Integridade ASAR embutida não está disponível no Linux e a migração de cookies não foi executada |
| Baixa de interface | A suíte desktop registra ocasionalmente `ResizeObserver loop completed with undelivered notifications` apesar de os casos funcionais passarem | Investigar medição/layout sob redimensionamento, repetir com observação de frames e registrar correção. Não é evidência de falha criptográfica nem de runtime inteiramente sem erros |
| Operacional | Build/container Docker não executados nesta máquina: acesso ao daemon local negado | Rodar builds dos dois Dockerfiles em ambiente descartável; Node 24 é testado separadamente e não substitui o ensaio do container |
| Operacional | Retenção de metadados/WAL/backups/reverse proxy depende da instalação | Política documentada de retenção, TLS/WSS, logs mínimos e credenciais separadas; verificar configuração real |

Não há autorização implícita para aceitar esses riscos em produção. Esta entrega não publica artefatos, não ativa atualizações obrigatórias e não remove fontes legadas reais. Os bloqueadores precisam de evidência externa ou implementação adicional; testes locais verdes não os encerram.
