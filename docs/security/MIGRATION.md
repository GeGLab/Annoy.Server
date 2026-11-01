# Plano de migração e recuperação

**Nenhuma das operações destrutivas abaixo foi executada nos dados reais.** Ferramentas recusam plano desatualizado, backup existente ou serviço ativo. Ensaiar numa cópia isolada e definir uma janela de manutenção. Um backup necessário à recuperação pode conter texto claro; sua retenção não pode ser confundida com conteúdo já apagado.

## Inventário anterior à implantação

Identificar `distopic.db`, WAL/SHM, FTS, uploads, avatares, clones Git, arquivos exportados, backups locais/remotos e snapshots do volume. No Global, identificar registros com escrow antigo e todas as cópias de `wrapped_keys`/cofres/segredo de escrow. No cliente, identificar localStorage antigo, cofre local, arquivos salvos fora do aplicativo e imagens completas do SO.

Separar mensagens legadas, mensagens MLS, temporários e permanentes. Avatares, membros, nomes de canais, código colaborativo e mídia legada não são conteúdo MLS. Não apagar arquivos não classificados automaticamente. Histórico legado sempre deve informar sua origem sem E2EE, inclusive após uma cópia cifrada atual.

## Contas: política exclusiva

Configuração aceita somente `ANNOY_ACCOUNT_MODE=global|local`; padrão global. Remover a flag antiga `ANNOY_GLOBAL`. Startup não muda a política persistida nem converte contas. Falhas do Global não mudam modo. Os comandos usam o diretório `ANNOY_DATA_DIR`; executá-los no checkout do servidor, com serviço parado:

```sh
npm run account:mode -- plan global local
npm run account:mode -- apply global local FINGERPRINT /backup/novo-before-mode.sqlite
```

Usar exatamente o fingerprint impresso, configurar o destino antes de reiniciar. Para banco antigo sem marcador, informar explicitamente a política de origem e revisar o plano. O comando faz backup SQLite 0600, verifica integridade/fingerprint e preserva IDs, cargos, permissões, propriedade, senhas e histórico; revoga sessões e códigos. Não inclui uploads nesse backup: cópia completa externa é necessária se a operação também envolver conteúdo.

Inscrição individual posterior exige comprovação da conta anterior e credencial do modo de destino. Recuperação administrativa local muda acesso à conta, não endossa dispositivos MLS. Contas com dispositivos, inclusive revogados, ou histórico não podem ser unificadas: manter ambos os IDs evita reatribuição de principal/autoria. Não vincular por nome/email. Fusões residuais sem histórico/dispositivos continuam exigindo prova das duas contas.

Rollback integral de backup de modo só serve no ensaio isolado e antes de tráfego novo. Não reabrir cópia restaurada à rede sem revogar sessões e conferir pins/revogações. Nunca substituir a base ativa por snapshot antigo depois de avançar grupos MLS.

## Legado: primeiro copiar e validar no cliente

A consulta **Arquivo legado** abre uma visualização separada, somente leitura, paginada em 50 mensagens, com anexos autenticados. Ela não mistura a origem legível com a timeline MLS.

No cliente atualizado: desbloquear cofre, revisar participantes e ativar a conversa MLS; usar **Copiar legado ao cofre**. Texto e anexos ficam no arquivo local separado, cifrado, com origem legada. A origem no servidor continua disponível. O cliente confere contagens, integridade AEAD e digest dos bytes dos anexos, e assina recibo por canal/usuário/dispositivo.

Todos os leitores atuais precisam de recibos de dispositivos ainda válidos para autorizar o expurgo offline. Recibo é uma atestação do cliente, não uma prova matemática de existência de um backup durável. Cada usuário deve exportar e testar o backup local cifrado antes da manutenção. Revogação de dispositivo, mudança de membros, texto ou bytes de arquivo invalida a prontidão do plano.

Limites assistidos atuais: 100 mil mensagens/canal, anexos individuais de 64 MiB, 512 MiB novos por passagem do cliente e 2 GiB de anexos por validação online do recibo. Excedentes preservam a origem e precisam de exportação assistida em lotes/revisão; não fazer expurgo forçado. Arquivo local em cache divergente da origem também impede validar o recibo. Não descartar dados para contornar o limite.

O backup em diretório inclui registros e anexos já copiados localmente. Não baixa automaticamente todos os anexos MLS antigos do servidor. O backup arquivo v1 tem teto de 40 MiB; preferir diretório para arquivos grandes. Guardar a chave de recuperação fora do backup e testar restauração em perfil descartável. Não enviar a chave ao administrador.

## Expurgo offline controlado

Parar todos os processos que usam o diretório. A trava PID/token deve ser respeitada por servidor e ferramentas; usar o mesmo namespace de PID. Não retirar manualmente trava válida. Se o estado estiver malformado, investigar antes de remover. Não executar dois administradores simultaneamente.

```sh
npm run content:legacy -- plan CANAL_A,CANAL_B
npm run content:legacy -- apply CANAL_A,CANAL_B FINGERPRINT /backup/novo-legado
```

O plano verifica SQLite e calcula compromisso de schema, dados, uploads, leitores e recibos; exige canais já MLS. Apply revalida o plano, cria um diretório NOVO fora dos dados com SQLite e todos os uploads, valida integridade/hashes e sincroniza arquivos antes de excluir a origem selecionada. Remove só mensagens legadas/anexos selecionados, reconstrói FTS, revoga sessões, usa secure_delete, checkpoint/VACUUM e verifica integridade. Arquivos não classificados permanecem. Contas, permissões, dispositivos e ciphertext MLS permanecem.

Se falhar antes do commit, a transação é desfeita. Falha após commit ou durante exclusão de blobs exige revisar o estado usando o backup validado; não repetir cegamente um fingerprint antigo. Manter ambos os diretórios até comprovar disponibilidade dos arquivos locais e concluir o período de recuperação definido.

## Restauração seletiva do legado

```sh
npm run content:legacy -- restore CANAL_A,CANAL_B /backup/novo-legado /backup/novo-estado-atual
```

Cria primeiro backup validado do estado atual. Valida integralmente a origem, rejeita caminhos/symlinks e colisões. Restaura apenas mensagens/anexos/reações antigos nos canais e autores que ainda existem; não recria contas nem rebobina épocas, revogações, permissões ou ciphertext novo. Remove temporariamente apenas o trigger de inserção para aquela transação offline, restaurando-o antes do commit. Todas as sessões são revogadas. Se canais/autores não existem, preservar o arquivo local em vez de reconstruir identidades automaticamente.

## Global e recuperação

Frontend e desktop bloqueiam uso do cofre com escrow antigo até rotação cliente: nova chave do cofre, novas chaves de recuperação e atualização CAS atômica. A identidade de login antiga é mantida para continuidade das instâncias; uma identidade já exposta pelo escrow não se torna retroativamente secreta. Recuperação por email não devolve chaves. Perda de todas as chaves exige iniciar um cofre vazio e não recupera mensagens cifradas.

Definir retenção e descarte das cópias legíveis antigas sob controle operacional. Backups antigos do Global, dispositivos e destinatários podem continuar comprometidos; nenhuma migração remove essas cópias remotamente. Apagar ou girar chaves não apaga o conhecimento de quem já as recebeu.

## Verificação pós-migração

Comparar IDs, cargos, permissões, propriedade, contagens/digests dos arquivos locais e novos envios MLS; tentar login no modo proibido, cliente antigo e insert SQLite sem a função administrativa. Testar rollback seletivo em ambiente isolado. Registrar duração, backups, hashes e responsáveis sem incluir chaves. Atualizadores continuam existentes, mas implantação/release/avisos obrigatórios aguardam autorização explícita.
