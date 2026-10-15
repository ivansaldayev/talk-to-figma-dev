# Figma MCP Skill

## Стратегия работы с Figma через MCP

### Принцип: Запрашивай минимум данных, двигайся от общего к частному

---

## 1. Разведка структуры (первый запрос)

Получи общую структуру с минимальной глубиной:

```json
{
  "nodeId": "...",
  "transform": {
    "maxDepth": 1,
    "maxChildren": 20,
    "typeFilter": { "exclude": ["VECTOR", "LINE", "ELLIPSE", "BOOLEAN_OPERATION"] },
    "simplifyStyles": true,
    "includeMetadata": true
  }
}
```

Это даст id, name, type детей и метаданные `_childrenCount`, `_truncated` для понимания размера.

---

## 2. Целевой запрос нужных нод

После определения интересующих нод, запрашивай их с нужными полями:

```json
{
  "nodeId": "конкретный-id",
  "transform": {
    "maxDepth": 2,
    "propertyFilter": {
      "include": ["id", "name", "type", "characters", "fills", "layoutMode", "itemSpacing"]
    },
    "simplifyStyles": true
  }
}
```

---

## 3. Итеративное погружение

Для больших деревьев используй пагинацию:

```json
{
  "nodeId": "...",
  "transform": {
    "maxDepth": 1,
    "pagination": { "page": 0, "pageSize": 20 },
    "includeMetadata": true
  }
}
```

Метаданные `_pagination.totalPages` покажут сколько ещё страниц.

---

## Параметры transform

| Параметр | Назначение |
|----------|-----------|
| `maxDepth` | Глубина дерева (0 = только сама нода: со свойствами, без детей, с `_childrenCount`) |
| `maxChildren` | Лимит детей на уровень |
| `typeFilter.exclude` | Исключить типы: `["VECTOR", "LINE", "ELLIPSE", "BOOLEAN_OPERATION"]` |
| `typeFilter.include` | Только эти типы: `["FRAME", "TEXT", "COMPONENT", "INSTANCE"]` |
| `propertyFilter.include` | Только нужные поля |
| `propertyFilter.exclude` | Исключить тяжёлые: `["absoluteBoundingBox", "relativeTransform"]` |
| `simplifyStyles` | Упростить fills/strokes до `{type, color, opacity}` |
| `includeMetadata` | Добавить `_path`, `_truncated`, `_childrenCount` |
| `pagination` | `{page: 0, pageSize: 20}` для больших списков |

---

## Типичные сценарии

### Найти все текстовые ноды

```json
{
  "transform": {
    "maxDepth": 10,
    "typeFilter": { "include": ["TEXT", "FRAME", "GROUP", "COMPONENT", "INSTANCE"] },
    "propertyFilter": { "include": ["id", "name", "type", "characters"] }
  }
}
```

### Получить структуру layout

```json
{
  "transform": {
    "maxDepth": 3,
    "propertyFilter": {
      "include": ["id", "name", "type", "layoutMode", "itemSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft"]
    }
  }
}
```

### Получить стили компонентов

```json
{
  "transform": {
    "typeFilter": { "include": ["COMPONENT", "INSTANCE", "FRAME"] },
    "simplifyStyles": true,
    "maxDepth": 2
  }
}
```

---

## Метаданные ответа

При `includeMetadata: true` ноды содержат:

| Поле | Описание |
|------|----------|
| `_path` | Путь от корня: `"Page / Frame / Component"` |
| `_truncated` | `true` если нода обрезана по `maxDepth` |
| `_childrenCount` | Количество детей у обрезанной ноды |
| `_childrenTruncated` | Сколько детей пропущено из-за `maxChildren` |
| `_excluded` | `true` если нода исключена по типу (при `excludeMode: "stub"`) |
| `_pagination` | `{page, pageSize, totalChildren, totalPages}` |

---

## Важно

- **Без параметра `transform`** — возвращается полный ответ (старое поведение)
- **Всегда начинай с `maxDepth: 1`** для разведки структуры
- **Используй `includeMetadata: true`** чтобы видеть что обрезано
- **`_truncated: true`** означает что у ноды есть дети, но они не загружены
- **`_childrenTruncated: N`** показывает сколько детей пропущено

---

## Инструменты с поддержкой transform

Transform есть только у инструментов, которые возвращают дерево нод:

- `get_document_info`
- `read_my_design`
- `get_node_info`
- `get_node_info_raw`
- `get_nodes_info`

У списочных инструментов (`get_selection`, `get_styles`, `get_local_components`, `scan_text_nodes`, `scan_nodes_by_types`, `get_annotations`, `get_reactions`) ответ не является деревом нод, поэтому их `transform` поддерживает только `pagination` — постраничный вывод верхнеуровневых списков:

```json
{"transform": {"pagination": {"page": 0, "pageSize": 3}}}
```

```json
{"count": 1304, "components": [ /* 3 items */ ], "_pagination": {"page": 0, "pageSize": 3, "totals": {"components": 1304}, "totalPages": 435}}
```

У `get_styles` листаются все четыре списка сразу (`colors`, `texts`, `effects`, `grids`), `totalPages` считается по самому длинному. У `get_instance_overrides` параметра `transform` нет.

В `get_document_info` дети страницы приходят с `childCount`, а с `transform` — с `_truncated: true` и `_childrenCount`: так видно, в какой секции есть содержимое, не загружая её.

## savePath

Есть у всех read-инструментов. Полный JSON-ответ записывается в файл, а в разговор приходит только сводка:

```json
{"savedTo": "/abs/path/components.json", "chars": 148213, "shape": {"count": 1304, "components": "[1304 items]"}}
```

Используй для больших ответов (`get_local_components`, `scan_text_nodes`), когда нужен весь список, а не одна страница, а потом читай файл по частям (`jq`, `Read` с `offset`). Если записать файл не удалось, придёт ошибка `Failed to save response to …`.
