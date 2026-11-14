# Coletor silencioso de alinhamentos

Bot de WhatsApp que acompanha grupos continuamente, reconhece conversas sobre alinhamento por contexto e registra informações comprovadas na planilha `Mr Alinhamento`. O bot não envia mensagens ao grupo.

## Funcionamento

- As conversas são mantidas separadas por grupo e ficam abertas para resultados que cheguem horas depois.
- O Gemini considera o texto, o título do grupo, a taxonomia, o glossário e as combinações de máquinas da planilha de configuração.
- Anexos JPEG, PNG, WebP e PDF são baixados em memória e enviados ao Gemini para leitura. Anexos acima de 20 MB ou em formatos não suportados são sinalizados para revisão. O conteúdo binário não é salvo na sessão; o resumo extraído é.
- A cada cinco minutos, o Gemini compara as mensagens e relatórios da sessão com os cabeçalhos da aba `Modelo alinhamento` e sincroniza uma linha. A primeira gravação preenche campos ausentes com `não informado`; sincronizações seguintes completam células ainda desconhecidas.
- Novos equipamentos iniciam uma atividade separada quando o Gemini consegue distingui-los. Se um dado posterior entrar em conflito com um valor já registrado, a linha preserva o valor comprovado, preenche outros campos ainda desconhecidos e sinaliza o conflito para revisão.
- Tolerâncias e medições são extraídas separadamente. O código não calcula valores nem conclui aceitabilidade sem dados compatíveis.
- Quando embarcação ou equipamento não podem ser associados com segurança, o bot ainda registra os demais dados com `não informado` na identidade ausente e cria uma pendência em `pending-alignment.jsonl` para esclarecimento. Não há perguntas automáticas no WhatsApp.

## Planilhas e permissões

- **Registros:** [Mr Alinhamento](https://docs.google.com/spreadsheets/d/1oc2u-thAhflrqEb3m6hxux8Yg6jEE6wGY-zFQyBRR38/edit), aba `Modelo alinhamento`; definir o ID em `SPREADSHEET_ID`.
- **Referências:** [Configuração - alinhamento](https://docs.google.com/spreadsheets/d/1KroIP08qi3FfpG5JO_aJgl8OHXcZvwBpEP2dL6ZCDKM/edit), abas `Taxonomia`, `Glossario`, `Configurações` e `Masterlist`; definir o ID em `CONFIG_SPREADSHEET_ID`.
- A conta de serviço do bot precisa de leitura na planilha de referências e edição na planilha de registros. Na VM, o Google Sheets usa Application Default Credentials da conta anexada; não use chaves privadas no repositório.
- `GEMINI_API_KEY` deve vir do ambiente ou do gerenciador de segredos. Nunca registre a chave nos logs.

Os cabeçalhos ocupam as linhas 1 e 2 e incluem grupos de colunas. O mapeamento é por título e grupo, inclusive para `Maker`, `Model` e `Equipment Class` repetidos. `Comments` contém o identificador da sessão usado para atualizar a mesma linha sem duplicá-la.

## Configuração

Variáveis obrigatórias:

```env
SPREADSHEET_ID=ID_DA_PLANILHA_DE_REGISTROS
CONFIG_SPREADSHEET_ID=ID_DA_PLANILHA_DE_REFERENCIAS
GEMINI_CONVERSATION_ENABLED=true
GEMINI_API_KEY=CHAVE_FORNECIDA_PELO_AMBIENTE
GEMINI_MODEL=gemini-3.1-flash-lite
```

Execute `npm install` e depois `npm start`. O serviço de produção é gerenciado por systemd na VM `alinhamento-bot`.

## Privacidade e operação

A lista de IDs processados e as sessões ficam em arquivos locais privados. `alignment-sessions.json` e `pending-alignment.jsonl` podem conter conteúdo operacional; mantenha-os fora do Git e com acesso restrito. O bot não publica mensagens nem cria perguntas no WhatsApp.

## Verificação

Rode `npm test` para verificar o mapeamento dos cabeçalhos, o preenchimento de desconhecidos e o isolamento das conversas. Para testar a leitura de um relatório, use um grupo de teste e um PDF ou imagem com dados fictícios. Confira a nova linha, depois envie uma complementação fictícia e confirme que só células `não informado` são preenchidas. Não use dados falsos na planilha operacional.
