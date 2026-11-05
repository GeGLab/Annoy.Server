# Migração de contas — modo exclusivo e explícito

`ANNOY_ACCOUNT_MODE=global` é o padrão; valores aceitos: `global` e `local`.
`ANNOY_GLOBAL` foi removido: sua presença impede inicialização com diagnóstico.
Modo local é escolha explícita e não consulta o Global. Uma falha Global nunca
habilita login local. Discord continua integração, não alternativa de autenticação.

## Mudança de modo da instância

Parar o serviço antes da operação. Reiniciar com configuração diferente NÃO migra
usuários: o startup falha. Banco com usuários sem modo registrado também exige
operação administrativa explícita. O comando de planejamento abre o banco somente
para leitura e imprime fingerprint do estado, contagens e impacto:

```sh
npm run account:mode -- plan global local
```

Usar o fingerprint impresso e um caminho NOVO para o backup:

```sh
npm run account:mode -- apply global local FINGERPRINT /backup/annoy-before-mode.sqlite
```

A aplicação cria backup consistente SQLite com permissões 0600, verifica integridade
e fingerprint, revalida o banco dentro da transação e muda somente a política.
Não sobrescreve backups. Mudanças desde o planejamento interrompem a operação.
Todas as sessões e códigos de recuperação são revogados. Vínculos globais, senhas,
IDs, cargos, propriedade e histórico são preservados. Não executa conversão de
contas nem une usuários por nome ou email. Configure o modo destino antes de reiniciar.

O backup desta operação contém o SQLite, NÃO os uploads. Antes de migrações de
conteúdo, copiar e validar também uploads, avatares e outros dados sob controle
do sistema. Este comando não migra conteúdo.

## Inscrição individual e recuperação

Após a mudança para Global, contas locais comprovam posse com senha e prova Global
válida. Após a mudança para Local, contas exclusivamente globais definem senha por
recuperação administrativa explícita. Nenhuma conta recebe a identidade de outra
por coincidência de nome. Fusões sem histórico/dispositivos continuam exigindo prova das duas contas. Contas com histórico não são unificadas, para preservar a autoria.

Para emitir código local, após verificar independentemente o proprietário:

```sh
npm run account:recover -- nome_do_usuario
```

Código é de uso único, hash no banco e validade de 30 minutos. Pode mudar acesso à
conta. Sessões antigas
sem expiração não valem mais, inclusive como prova de migração. Senhas scrypt são
verificadas e atualizadas para Argon2id somente após login local válido.

## Recuperação operacional

Testar restauração numa cópia isolada antes da operação real. Com serviço parado,
restaurar backup íntegro em novo diretório e usar configuração de origem. Não copiar
um arquivo SQLite sobre banco aberto; remover/reconciliar WAL e SHM somente com
procedimento SQLite e todas as conexões fechadas. A restauração de backup prévio
pode restaurar tokens existentes: revogue sessões antes de tornar a cópia acessível.


## Compatibilidade e atualização

Node.js >=24.7 é necessário para Argon2 nativo; Docker usa Node 24.
Atualizadores existentes são preservados. Não foi publicada release nem ativado
aviso obrigatório. Publicação depende de autorização explícita após validação.
