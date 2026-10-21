#!/usr/bin/env bash
#
# scaffold.sh — 把新專案的三層骨架擺好。
#
# 存在的理由：分層只要有一次偷懶就前功盡棄。namecard-archive 就是這樣變成
# 根目錄一堆 .jsonl 與 .html 的。骨架建立是純機械性的工作，交給腳本比交給
# 當下的判斷可靠。
#
# 這支腳本跑在 `proj new <name>` 之後——proj new 負責目錄、git、GitHub repo
# 與配埠，但它寫進 projects.json 的 start 是 `npm run dev`，對前後端分離的
# 專案是錯的（見 newproject.mjs:128）。這裡會回頭把那筆改對。
#
# 用法：
#   scaffold.sh <name> [選項]
#
#   --dir <path>       專案目錄（預設 ~/Projects/<name>）
#   --web-port <n>     前端埠（預設從 projects.json 讀 proj new 配好的）
#   --api-port <n>     後端埠（同上）
#   --db <name>        資料庫名（預設把專案名的連字號換成底線）
#   --no-frontend      不建前端（CLI 工具、純後端服務）
#   --no-db            不建資料庫層（無持久化需求）
#   --no-registry      不去改 projects.json（測試用）
#   --no-createdb      不執行 createdb（測試用，或資料庫已存在）
#
set -euo pipefail

PROJECTS_ROOT="$HOME/Projects"
REGISTRY="$PROJECTS_ROOT/projctl/projects.json"
[ -f "$REGISTRY" ] || REGISTRY="$PROJECTS_ROOT/.projctl/projects.json"   # 2026-10-01 前的舊名

NAME=""; DIR=""; WEB_PORT=""; API_PORT=""; DB=""
WITH_FRONTEND=1; WITH_DB=1; WITH_REGISTRY=1; WITH_CREATEDB=1

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)         DIR="$2"; shift 2 ;;
    --web-port)    WEB_PORT="$2"; shift 2 ;;
    --api-port)    API_PORT="$2"; shift 2 ;;
    --db)          DB="$2"; shift 2 ;;
    --no-frontend) WITH_FRONTEND=0; shift ;;
    --no-db)       WITH_DB=0; shift ;;
    --no-registry) WITH_REGISTRY=0; shift ;;
    --no-createdb) WITH_CREATEDB=0; shift ;;
    -h|--help)     sed -n '2,25p' "$0"; exit 0 ;;
    -*)            echo "不認得的選項：$1" >&2; exit 1 ;;
    *)             NAME="$1"; shift ;;
  esac
done

[ -n "$NAME" ] || { echo "用法：scaffold.sh <name> [選項]（--help 看全部）" >&2; exit 1; }
# **整串比對，不要寫成 `[a-z0-9]*`。** glob 的 `*` 匹配任意後綴，所以那種寫法
# 只檢查第一個字元：`a/../../tmp/evil` 會通過，然後 DIR 落到 ~/Projects 外面；
# `a|b` 會通過，然後 subst() 的 sed 直接報 bad flag in substitute command。
case "$NAME" in
  *[!a-z0-9-]* | -* | *- | '')
    echo "專案名只能是小寫字母、數字、連字號，且不能以連字號開頭或結尾。" >&2; exit 1 ;;
esac

DIR="${DIR:-$PROJECTS_ROOT/$NAME}"
DB="${DB:-$(printf '%s' "$NAME" | tr '-' '_')}"

# ---------------------------------------------------------------- 埠位
# 埠位一律由 proj new 分配，不要自己挑。撞埠的症狀是「打開網頁看到另一個
# 專案」，而且因為 IPv4/IPv6 分裂，兩個服務可能都綁得成功、不報 EADDRINUSE。
if { [ -z "$WEB_PORT" ] || [ -z "$API_PORT" ]; } && [ -f "$REGISTRY" ]; then
  eval "$(node -e '
    const fs = require("fs");
    const reg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const p = reg.projects.find((x) => x.name === process.argv[2]);
    if (!p) process.exit(0);
    const pick = (label) => (p.ports.find((x) => x.label === label) || {}).port;
    const web = pick("web") ?? p.ports[0]?.port;
    const api = pick("api") ?? p.ports[1]?.port;
    if (web) console.log(`WEB_PORT=${web}`);
    if (api) console.log(`API_PORT=${api}`);
  ' "$REGISTRY" "$NAME")"
fi

if [ -z "${WEB_PORT:-}" ] || [ -z "${API_PORT:-}" ]; then
  # 變數後面緊接中文標點時一定要加大括號：這個 bash 會把多位元組字元的
  # 位元組當成變數名的一部分，於是 set -u 報 "unbound variable"。
  echo "找不到埠位。先跑 proj new ${NAME}，或用 --web-port / --api-port 指定。" >&2
  exit 1
fi

[ -d "$DIR" ] || mkdir -p "$DIR"

# 已經有骨架就不要蓋掉——重跑一次不該把改過的程式碼洗掉。
if [ -d "$DIR/backend/app" ]; then
  echo "$DIR/backend/app 已經存在，不覆蓋。要重建先自己刪掉。" >&2
  exit 1
fi

# 所有樣板都用 quoted heredoc 寫（裡面的 $ 原樣保留），再統一過這一道替換。
subst() {
  sed -e "s|__NAME__|$NAME|g" \
      -e "s|__DB__|$DB|g" \
      -e "s|__WEB_PORT__|$WEB_PORT|g" \
      -e "s|__API_PORT__|$API_PORT|g"
}

say() { printf '  \033[32m✓\033[0m %s\n' "$1"; }

printf '\n  建立 \033[1m%s\033[0m 的三層骨架…\n\n' "$NAME"

# ================================================================ db/
if [ "$WITH_DB" = 1 ]; then
  mkdir -p "$DIR/db"

  # schema.sql 是資料表的唯一真相，不是 SQLAlchemy 的 metadata.create_all。
  # 理由：create_all 只會建「還不存在」的表，改欄位它一聲不吭，於是本機跟
  # 真實結構會慢慢分岔。SQL 檔改了就看得見，也能直接餵給 psql。
  subst > "$DIR/db/schema.sql" <<'EOF'
-- __NAME__ 的資料表定義。這裡是唯一真相。
--
-- 改動流程：改這個檔 → psql -d __DB__ -f db/schema.sql → 同步改
-- backend/app/models/ 底下對應的 ORM 定義。兩邊要一起改，不要只改一邊。
--
-- 刻意不用 SQLAlchemy 的 metadata.create_all()：它只建不存在的表，
-- 欄位改了它不會講話，本機結構會跟這個檔悄悄分岔。

CREATE TABLE IF NOT EXISTS items (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(200)  NOT NULL,
  note        VARCHAR(1000),
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT now()
);
EOF

  subst > "$DIR/db/seed.sql" <<'EOF'
-- 開發用的假資料。正式環境不要跑這個。
INSERT INTO items (name, note) VALUES
  ('第一筆', '這是 scaffold 產生的示範資料'),
  ('第二筆', NULL);
EOF
  say "db/（schema.sql · seed.sql）"
fi

# ================================================================ backend/
mkdir -p "$DIR/backend/app"/{schemas,repositories,services,routers}
[ "$WITH_DB" = 1 ] && mkdir -p "$DIR/backend/app/models"

# 版本釘死在這台機器上實測可用的組合（Python 3.14.6 + PostgreSQL 17.10），
# 取自 interior-designer 的 requirements.txt。不是「最新」，是「驗證過會動」。
if [ "$WITH_DB" = 1 ]; then
  subst > "$DIR/backend/requirements.txt" <<'EOF'
fastapi==0.141.1
uvicorn==0.52.1
SQLAlchemy==2.0.51
psycopg==3.3.4
psycopg-binary==3.3.4
pydantic==2.13.4
pytest==9.1.1
EOF
else
  subst > "$DIR/backend/requirements.txt" <<'EOF'
fastapi==0.141.1
uvicorn==0.52.1
pydantic==2.13.4
EOF
fi

subst > "$DIR/backend/app/__init__.py" <<'EOF'
EOF

subst > "$DIR/backend/app/config.py" <<'EOF'
"""環境設定集中在這裡讀。

**其他地方一律不要碰 os.environ。** 散在各處的環境變數讀取是最難追的一種
設定 bug：你改了 .env 卻有一半的程式沒吃到，而且看程式碼看不出來還有誰在讀。
"""

import os

API_PORT = int(os.environ.get("API_PORT", "__API_PORT__"))
WEB_PORT = int(os.environ.get("WEB_PORT", "__WEB_PORT__"))

# 開發時前端走 vite 的 proxy 打 /api，照理不需要 CORS；但直接用 curl 或
# 另開埠測試時會需要，留著成本是零。
CORS_ORIGINS = [
    f"http://localhost:{WEB_PORT}",
    f"http://127.0.0.1:{WEB_PORT}",
]
EOF

if [ "$WITH_DB" = 1 ]; then
subst >> "$DIR/backend/app/config.py" <<'EOF'

# 本機共用的 PostgreSQL（brew 裝的那個，proj 的 deps: ["postgres"] 會預檢）。
# 不是每個專案一個 Docker 容器——這台機器上 docker info 在 daemon 沒跑時
# 會卡兩分鐘，多綁一層等於多一個會壞的地方。
DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql+psycopg://localhost/__DB__"
)
EOF

subst > "$DIR/backend/app/db.py" <<'EOF'
"""資料庫連線與 session。

session 只能透過 get_session() 取得。自己 new 一個 SessionLocal() 的話，
請求結束時沒人關它，連線會慢慢漏光——症狀是跑久了才開始出現
"remaining connection slots are reserved"，而且很難對回是哪一段程式。
"""

from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import DATABASE_URL

engine = create_engine(DATABASE_URL, future=True, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    """所有 ORM 模型的共同基底。"""


def get_session() -> Iterator[Session]:
    """FastAPI 的依賴注入用。routers 一律 Depends(get_session)。"""
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
EOF

subst > "$DIR/backend/app/models/__init__.py" <<'EOF'
EOF

subst > "$DIR/backend/app/models/item.py" <<'EOF'
"""資料表的 ORM 定義。

改這裡的時候 **db/schema.sql 要一起改**——那個檔才是真相，這裡只是 Python
這一側的對應。兩邊分岔的症狀是「本機好好的，換一台機器就 column does not exist」。
"""

from datetime import datetime

from sqlalchemy import DateTime, String, func
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


class Item(Base):
    __tablename__ = "items"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    note: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
EOF

subst > "$DIR/backend/app/schemas/__init__.py" <<'EOF'
EOF

subst > "$DIR/backend/app/schemas/item.py" <<'EOF'
"""進出 API 的資料形狀（Pydantic）。

跟 models/ 刻意分開：ORM 模型是「資料庫裡長什麼樣」，schema 是「對外承諾
長什麼樣」。直接把 ORM 模型當回傳型別的話，哪天加一個內部欄位（password_hash、
internal_note）就會不小心一起吐出去。
"""

from datetime import datetime

from pydantic import BaseModel


class ItemCreate(BaseModel):
    name: str
    note: str | None = None


class ItemOut(BaseModel):
    id: int
    name: str
    note: str | None
    created_at: datetime

    model_config = {"from_attributes": True}
EOF

subst > "$DIR/backend/app/repositories/__init__.py" <<'EOF'
EOF

subst > "$DIR/backend/app/repositories/item_repo.py" <<'EOF'
"""**唯一可以碰資料庫的地方。**

規則：只有這個目錄底下的檔案能 import sqlalchemy 或寫 SQL。
services/ 與 routers/ 都不行。

為什麼要這麼硬：SQL 散在 route handler 裡的時候，改一個欄位名要全域搜尋，
而且搜不乾淨——字串拼接的查詢 grep 不到。把它關在一個目錄裡，改欄位就只是
改這個目錄。
"""

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models.item import Item


def list_items(db: Session) -> list[Item]:
    return list(db.scalars(select(Item).order_by(Item.id.desc())))


def get_item(db: Session, item_id: int) -> Item | None:
    return db.get(Item, item_id)


def create_item(db: Session, *, name: str, note: str | None) -> Item:
    item = Item(name=name, note=note)
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


def delete_item(db: Session, item_id: int) -> bool:
    """刪掉回 True，本來就不存在回 False。"""
    item = db.get(Item, item_id)
    if item is None:
        return False
    db.delete(item)
    db.commit()
    return True
EOF

subst > "$DIR/backend/app/services/__init__.py" <<'EOF'
EOF

subst > "$DIR/backend/app/services/item_service.py" <<'EOF'
"""業務邏輯。

規則：**不知道 HTTP，也不寫 SQL。**
不 import fastapi（不認得 HTTPException、Request、status code），
不 import sqlalchemy（要碰資料庫就叫 repositories）。

為什麼：這一層是唯一值得單元測試的地方。它一旦沾到 HTTP，測試就得起一個
測試用 client；一旦沾到 SQL，測試就得起一個資料庫。兩個都很快讓人放棄寫測試。

錯誤用自訂例外表達，由 routers 翻譯成 HTTP 狀態碼——這一層不該知道
「找不到」對應的是 404。
"""

from sqlalchemy.orm import Session

from ..repositories import item_repo
from ..schemas.item import ItemCreate


class ItemNotFound(Exception):
    """指定的 item 不存在。"""


class InvalidItem(ValueError):
    """送進來的資料不合規則。"""


def list_items(db: Session):
    return item_repo.list_items(db)


def create_item(db: Session, data: ItemCreate):
    name = data.name.strip()
    if not name:
        raise InvalidItem("name 不能是空白")
    return item_repo.create_item(db, name=name, note=data.note)


def delete_item(db: Session, item_id: int) -> None:
    if not item_repo.delete_item(db, item_id):
        raise ItemNotFound(item_id)
EOF

subst > "$DIR/backend/app/routers/__init__.py" <<'EOF'
EOF

subst > "$DIR/backend/app/routers/items.py" <<'EOF'
"""HTTP 進來的第一站。

規則：**不寫業務邏輯、不寫 SQL。** 這裡只做三件事——
收參數、叫 services、把例外翻譯成 HTTP 狀態碼。

如果你發現自己在這個檔案裡寫 if/else 判斷業務規則，那段該搬去 services/。
"""

from fastapi import APIRouter, Depends, HTTPException

from ..db import get_session
from ..schemas.item import ItemCreate, ItemOut
from ..services import item_service

router = APIRouter(prefix="/api/items", tags=["items"])


@router.get("", response_model=list[ItemOut])
def list_items(db=Depends(get_session)):
    return item_service.list_items(db)


@router.post("", response_model=ItemOut, status_code=201)
def create_item(payload: ItemCreate, db=Depends(get_session)):
    try:
        return item_service.create_item(db, payload)
    except item_service.InvalidItem as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


@router.delete("/{item_id}", status_code=204)
def delete_item(item_id: int, db=Depends(get_session)):
    try:
        item_service.delete_item(db, item_id)
    except item_service.ItemNotFound as e:
        raise HTTPException(status_code=404, detail="item 不存在") from e
EOF

subst > "$DIR/backend/app/main.py" <<'EOF'
"""FastAPI 進入點：建 app、掛 middleware、掛 router。

這個檔案要保持很短。任何「做事」的程式碼都屬於 routers/services/repositories
其中一層，不屬於這裡。
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from . import config
from .db import engine
from .routers import items

app = FastAPI(title="__NAME__")

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(items.router)


@app.get("/health")
def health():
    """連資料庫一起檢查。

    只回 {"ok": true} 的健康檢查沒有用——服務活著但連不上資料庫是最常見的
    故障型態，而那種狀態下純 HTTP 檢查一樣是 200。
    """
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except Exception as e:
        return {"ok": False, "db": f"{type(e).__name__}: {e}"}
    return {"ok": True, "db": "ok"}
EOF

  # ---------------------------------------------------------------- 測試
  # 分層的實質回報就在這裡：services 不沾 HTTP 也不沾 SQL，所以它的測試
  # 不用起資料庫、不用起 test client，毫秒就跑完。
  #
  # 骨架一定要附一個能跑的測試。專案第一天是補測試最容易的時候（只有一條
  # 示範 CRUD），錯過就很難回頭——loan-ledger 是這台機器上唯一沒有經過骨架
  # 直接長出來的專案，也是唯一 0 個測試的。
  mkdir -p "$DIR/backend/tests"

  # 空的 conftest.py 放在 backend/ 而不是 tests/：pytest 會把 conftest 所在的
  # 目錄加進 sys.path，`from app...` 才 import 得到。放在 tests/ 底下的話
  # 加進去的是 tests/，import 會失敗。
  subst > "$DIR/backend/conftest.py" <<'EOF'
# 這個檔案刻意留空。
#
# 它的作用不是內容，是位置：pytest 會把 conftest.py 所在的目錄加進 sys.path，
# 所以測試裡才能 `from app.services import ...`。搬到 tests/ 底下就會壞掉。
EOF

  subst > "$DIR/backend/pytest.ini" <<'EOF'
[pytest]
testpaths = tests
EOF

  subst > "$DIR/backend/tests/test_item_service.py" <<'EOF'
"""services 這一層的測試——不起資料庫、不起 HTTP。

**這是三層分層唯一的實質回報。** 業務規則可以在毫秒內驗證，不需要 PostgreSQL
在跑，也不需要 FastAPI 的 test client。

反過來也是一個檢查：如果哪天這個檔案開始需要「先起一個資料庫」的 fixture，
表示有 SQL 漏進 services 了，該把它搬回 repositories。

跑法（在 backend/ 底下）：

    ./.venv/bin/pytest          # Windows（Git Bash）：./.venv/Scripts/pytest
"""

import pytest

from app.schemas.item import ItemCreate
from app.services import item_service


class FakeRepo:
    """假的 repositories。

    只記下自己被叫了什麼，完全不碰資料庫。services 只透過 repositories 取用
    資料，所以整層換掉就能把資料庫從測試裡拿走——這是分層換來的，不是技巧。
    """

    def __init__(self):
        self.rows = []
        self.deleted = []
        self.delete_returns = True

    def list_items(self, db):
        return self.rows

    def create_item(self, db, *, name, note):
        row = {"name": name, "note": note}
        self.rows.append(row)
        return row

    def delete_item(self, db, item_id):
        self.deleted.append(item_id)
        return self.delete_returns


@pytest.fixture
def repo(monkeypatch):
    fake = FakeRepo()
    monkeypatch.setattr(item_service, "item_repo", fake)
    return fake


def test_create_strips_surrounding_whitespace(repo):
    """名稱前後的空白要清掉——不然「甲」跟「甲 」會變成兩筆。"""
    item_service.create_item(None, ItemCreate(name="  甲  "))
    assert repo.rows[0]["name"] == "甲"


def test_create_rejects_blank_name(repo):
    """只有空白的名稱要擋下來，而且是 services 擋的，不是 router。"""
    with pytest.raises(item_service.InvalidItem):
        item_service.create_item(None, ItemCreate(name="   "))
    assert repo.rows == []


def test_delete_missing_raises_not_found(repo):
    """刪不存在的要拋自訂例外，不是回 404。

    services 不該知道「找不到」對應的是哪個 HTTP 狀態碼——那是 routers 的事。
    """
    repo.delete_returns = False
    with pytest.raises(item_service.ItemNotFound):
        item_service.delete_item(None, 999)


def test_delete_existing_passes_through(repo):
    item_service.delete_item(None, 1)
    assert repo.deleted == [1]
EOF
else
  # ---------------------------------------------------------------- 無持久化
  # --no-db 的變體：不產生任何會連資料庫的程式碼。
  #
  # 之前這裡照樣產生 db.py 與示範 CRUD，結果是後端起得來、/health 卻回
  # ok:false、/api/items 直接 500——一個「跑得起來但壞掉」的骨架比沒有更糟，
  # 因為它看起來像是能用的。
  #
  # 分層目錄還是建，並在 __init__.py 裡寫明各層職責：之後要接資料庫時
  # 位置已經留好，不用重新決定要放哪。
  subst > "$DIR/backend/app/routers/__init__.py" <<'EOF'
"""HTTP 進來的第一站。

規則：**不寫業務邏輯、不寫 SQL。** 只做三件事——收參數、叫 services、
把例外翻譯成 HTTP 狀態碼。在這裡寫 if/else 判斷業務規則就是放錯層。
"""
EOF

  subst > "$DIR/backend/app/services/__init__.py" <<'EOF'
"""業務邏輯。

規則：**不知道 HTTP，也不寫 SQL。** 不 import fastapi、不 import sqlalchemy。
要碰資料就叫 repositories。錯誤用自訂例外表達，由 routers 翻成狀態碼。

這一層是唯一值得單元測試的地方——它一旦沾到 HTTP 就要起 test client，
沾到 SQL 就要起資料庫，兩個都很快讓人放棄寫測試。
"""
EOF

  subst > "$DIR/backend/app/repositories/__init__.py" <<'EOF'
"""**唯一可以碰持久化的地方。**

這個專案目前沒有資料庫（scaffold 跑的是 --no-db）。之後要接的時候：

    1. 建 db/schema.sql，createdb <name>，psql -f 套用
    2. 在 backend/app/db.py 建 engine 與 get_session()
    3. 資料表的 ORM 對應放 backend/app/models/
    4. 存取邏輯**只**寫在這個目錄底下

規則不變：只有這裡能 import sqlalchemy 或寫 SQL，services 與 routers 都不行。
"""
EOF

  subst > "$DIR/backend/app/schemas/__init__.py" <<'EOF'
"""進出 API 的資料形狀（Pydantic）。

跟 models/（資料庫長什麼樣）刻意分開：這裡是「對外承諾長什麼樣」。
直接把 ORM 模型當回傳型別的話，哪天加一個內部欄位就會不小心一起吐出去。
"""
EOF

  subst > "$DIR/backend/app/main.py" <<'EOF'
"""FastAPI 進入點：建 app、掛 middleware、掛 router。

這個檔案要保持很短。任何「做事」的程式碼都屬於 routers/services/repositories
其中一層，不屬於這裡。
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import config

app = FastAPI(title="__NAME__")

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"ok": True}


# 加第一個功能時：在 routers/ 建一個模組，在這裡 include_router()。
# 業務邏輯放 services/，碰資料的部分放 repositories/——即使現在只是
# 讀一個 JSON 檔，也放那裡，之後換成資料庫才不用動上面兩層。
EOF
fi
say "backend/（routers → services → repositories）"
if [ "$WITH_DB" = 1 ]; then
  say "backend/tests/（services 的單元測試，不需要資料庫）"
fi

# ================================================================ frontend/
if [ "$WITH_FRONTEND" = 1 ]; then
  mkdir -p "$DIR/frontend/src/api"

  subst > "$DIR/frontend/package.json" <<'EOF'
{
  "name": "__NAME__-frontend",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.1",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.6.0",
    "typescript": "^5.6.0",
    "vite": "^6.3.5"
  }
}
EOF

  subst > "$DIR/frontend/vite.config.ts" <<'EOF'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 前端一律打相對路徑 /api，由這個 proxy 轉到後端。
//
// 為什麼不讓前端直接打 http://localhost:<api_port>：那樣後端埠會被寫死在
// 前端程式碼裡，換埠要改兩個地方，而且部署到同源環境時還要再改回來。
const API_PORT = process.env.API_PORT ?? '__API_PORT__'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: true },
      '/health': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: true },
    },
  },
})
EOF

  subst > "$DIR/frontend/tsconfig.json" <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true
  },
  "include": ["src"]
}
EOF

  subst > "$DIR/frontend/index.html" <<'EOF'
<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>__NAME__</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
EOF

  if [ "$WITH_DB" = 1 ]; then
  subst > "$DIR/frontend/src/types.ts" <<'EOF'
// 對應後端 backend/app/schemas/item.py。
//
// 後端改了 schema 這裡要一起改——這是前端這一側唯一知道後端資料長相的地方，
// 改一個檔就夠。散在各個 component 裡的 any 是型別擋不住後端改動的主因。

export interface Item {
  id: number
  name: string
  note: string | null
  created_at: string
}

export interface ItemCreate {
  name: string
  note?: string | null
}
EOF
  else
  subst > "$DIR/frontend/src/types.ts" <<'EOF'
// 後端 API 的資料形狀寫在這裡，對應 backend/app/schemas/。
//
// 這是前端唯一知道後端資料長相的地方——後端改 schema 就只改這個檔。
// 散在各個 component 裡的 any 是型別擋不住後端改動的主因。

export {}
EOF
  fi

  subst > "$DIR/frontend/src/api/client.ts" <<'EOF'
// **唯一可以呼叫後端的地方。**
//
// 規則：component 不准直接 fetch。全部經過這裡。
// 為什麼：錯誤處理、base path、之後要加的認證 header，都只有集中才改得動。
// fetch 散在 component 裡的時候，加一個 401 自動導向登入要改二十個檔案。
EOF

  if [ "$WITH_DB" = 1 ]; then
    subst >> "$DIR/frontend/src/api/client.ts" <<'EOF'

import type { Item, ItemCreate } from '../types'
EOF
  fi

  subst >> "$DIR/frontend/src/api/client.ts" <<'EOF'

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!res.ok) {
    const detail = await res.text()
    throw new ApiError(res.status, detail || res.statusText)
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
}

EOF

  if [ "$WITH_DB" = 1 ]; then
    subst >> "$DIR/frontend/src/api/client.ts" <<'EOF'
export const api = {
  health: () => request<{ ok: boolean; db: string }>('/health'),
  listItems: () => request<Item[]>('/api/items'),
  createItem: (data: ItemCreate) =>
    request<Item>('/api/items', { method: 'POST', body: JSON.stringify(data) }),
  deleteItem: (id: number) =>
    request<void>(`/api/items/${id}`, { method: 'DELETE' }),
}
EOF
  else
    subst >> "$DIR/frontend/src/api/client.ts" <<'EOF'
// 加新的 API 就往這個物件裡加，不要在 component 裡直接 fetch。
export const api = {
  health: () => request<{ ok: boolean }>('/health'),
}
EOF
  fi

  subst >> "$DIR/frontend/src/api/client.ts" <<'EOF'

export { ApiError }
EOF

  subst > "$DIR/frontend/src/main.tsx" <<'EOF'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
EOF

  if [ "$WITH_DB" = 0 ]; then
  subst > "$DIR/frontend/src/App.tsx" <<'EOF'
// scaffold 產生的起始畫面：只確認前端打得到後端。
//
// 這個專案沒有資料庫（--no-db），所以沒有貫穿三層的示範。加功能時規則不變：
// component 不直接 fetch，一律走 api/client.ts。

import { useEffect, useState } from 'react'
import { api } from './api/client'

export default function App() {
  const [health, setHealth] = useState('檢查中…')

  useEffect(() => {
    api
      .health()
      .then((h) => setHealth(h.ok ? '後端通了' : '後端回報異常'))
      .catch((e) => setHealth(`後端打不到：${e}`))
  }, [])

  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 640, margin: '3rem auto', padding: '0 1rem' }}>
      <h1>__NAME__</h1>
      <p style={{ color: '#666' }}>{health}</p>
    </main>
  )
}
EOF
  else
  subst > "$DIR/frontend/src/App.tsx" <<'EOF'
// 這是 scaffold 產生的示範畫面，貫穿三層：
//   App.tsx → api/client.ts → FastAPI router → service → repository → PostgreSQL
//
// 開始寫真正的功能時可以整個刪掉。留著的價值是「照這條線抄就對了」。

import { useEffect, useState } from 'react'
import { api } from './api/client'
import type { Item } from './types'

export default function App() {
  const [items, setItems] = useState<Item[]>([])
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [health, setHealth] = useState<string>('檢查中…')

  const reload = () =>
    api
      .listItems()
      .then(setItems)
      .catch((e) => setError(String(e)))

  useEffect(() => {
    api
      .health()
      .then((h) => setHealth(h.ok ? '後端與資料庫都通' : `資料庫異常：${h.db}`))
      .catch((e) => setHealth(`後端打不到：${e}`))
    reload()
  }, [])

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      await api.createItem({ name })
      setName('')
      reload()
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 640, margin: '3rem auto', padding: '0 1rem' }}>
      <h1>__NAME__</h1>
      <p style={{ color: '#666' }}>{health}</p>

      <form onSubmit={add} style={{ display: 'flex', gap: 8, margin: '1.5rem 0' }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="新增一筆"
          style={{ flex: 1, padding: 8 }}
        />
        <button type="submit">新增</button>
      </form>

      {error && <p style={{ color: 'crimson' }}>{error}</p>}

      <ul style={{ listStyle: 'none', padding: 0 }}>
        {items.map((it) => (
          <li key={it.id} style={{ display: 'flex', gap: 8, padding: '6px 0', borderBottom: '1px solid #eee' }}>
            <span style={{ flex: 1 }}>{it.name}</span>
            <button onClick={() => api.deleteItem(it.id).then(reload)}>刪除</button>
          </li>
        ))}
      </ul>
    </main>
  )
}
EOF
  fi
  say "frontend/（React + TypeScript + Vite）"
fi

# ================================================================ 專案根目錄
subst > "$DIR/.env.example" <<'EOF'
# 這個檔進版控，.env 不進。
#
# 埠位不是祕密，寫實際值——clone 下來直接 cp .env.example .env 就能跑。
# 真的有金鑰的時候才在這裡留空白佔位。

WEB_PORT=__WEB_PORT__
API_PORT=__API_PORT__
EOF

if [ "$WITH_DB" = 1 ]; then
  subst >> "$DIR/.env.example" <<'EOF'

# 本機共用的 PostgreSQL（brew 裝的那個），不是 Docker 容器。
DATABASE_URL=postgresql+psycopg://localhost/__DB__
EOF
fi
cp "$DIR/.env.example" "$DIR/.env"

subst > "$DIR/run.sh" <<'EOF'
#!/usr/bin/env bash
# 一鍵啟動後端與前端，Ctrl-C 一起結束。
#
# 埠位與資料庫位址從 .env 讀，不要寫死在這裡——寫死的後果是換埠要改三個
# 地方，而且一定會漏掉一個。
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# .env 不進版控，所以新 clone 下來沒有。直接從範本補一份。
[ -f "$DIR/.env" ] || cp "$DIR/.env.example" "$DIR/.env"
set -a; . "$DIR/.env"; set +a

# 後端：首次執行自動建 venv 並安裝相依
VENV="$DIR/backend/.venv"
NEW_VENV=0
if [ ! -d "$VENV" ]; then
  echo "▶ 建立後端 venv 並安裝相依…"
  python3 -m venv "$VENV"
  NEW_VENV=1
fi

# venv 放執行檔的目錄兩個平台不一樣：POSIX 是 bin/，Windows 是 Scripts/。
# 用 if/else 不用 `[ -d ] && VBIN=`——後者在條件不成立時整句回傳 1，
# 配上 set -e 會直接把腳本結束掉。
if [ -d "$VENV/Scripts" ]; then VBIN="$VENV/Scripts"; else VBIN="$VENV/bin"; fi

if [ "$NEW_VENV" = 1 ]; then
  "$VBIN/pip" install -q --upgrade pip
  "$VBIN/pip" install -q -r "$DIR/backend/requirements.txt"
fi

if [ -d "$DIR/frontend" ] && [ ! -d "$DIR/frontend/node_modules" ]; then
  echo "▶ 安裝前端相依…"
  (cd "$DIR/frontend" && npm install)
fi

echo "▶ 後端 http://localhost:$API_PORT   前端 http://localhost:$WEB_PORT"
trap 'kill 0' EXIT

(cd "$DIR/backend" && "$VBIN/uvicorn" app.main:app --reload --port "$API_PORT") &

# --strictPort 是刻意的：vite 預設埠被佔住時會自己換一個，然後你看到的
# 網址跟 projects.json 登記的不一樣，proj status 會說這個專案沒在跑。
[ -d "$DIR/frontend" ] && \
  (cd "$DIR/frontend" && npm run dev -- --port "$WEB_PORT" --strictPort) &

wait
EOF
chmod +x "$DIR/run.sh"
say "run.sh · .env.example"

# ---------------------------------------------------------------- .gitignore
# proj new 已經寫過一份，這裡只補這個骨架特有的。
for line in ".venv/" "node_modules/" ".env" "__pycache__/" "dist/" ".pytest_cache/"; do
  if [ ! -f "$DIR/.gitignore" ] || ! grep -qxF "$line" "$DIR/.gitignore"; then
    printf '%s\n' "$line" >> "$DIR/.gitignore"
  fi
done

# ================================================================ AGENTS.md
# 分層規則寫進專案自己的 AGENTS.md（跨工具標準檔名），規則跟著專案走。
# 只放在 skill 裡是不夠的——半年後改這個專案的人（或 session）不見得會載到
# 那個 skill，但一定會讀專案的 AGENTS.md（Claude Code 透過 CLAUDE.md 的 import 讀到）。
if [ -f "$DIR/AGENTS.md" ]; then
  echo "  · AGENTS.md 已存在，沒有覆蓋（分層規則請自己併進去）"
else
  subst > "$DIR/AGENTS.md" <<'EOF'
# AGENTS.md

## Overview

（這是什麼、解決什麼問題，兩三句。scaffold 填不了，自己補。）

## Tech Stack
EOF

  if [ "$WITH_DB" = 1 ]; then
    subst >> "$DIR/AGENTS.md" <<'EOF'

FastAPI + SQLAlchemy + PostgreSQL · React + TypeScript + Vite

資料庫接的是**本機共用的 PostgreSQL**（brew 裝的常駐服務），不是每個專案
一個 Docker 容器。理由：`proj start` 的 `deps: ["postgres"]` 已經會預檢它，
而這台機器上 Docker 的存活檢查有坑（`docker info` 在 daemon 沒跑時會卡兩分鐘）。

## Build & Run

```bash
proj start __NAME__          # 或直接 ./run.sh
```

| | |
|---|---|
| 前端 | http://localhost:__WEB_PORT__ |
| 後端 | http://localhost:__API_PORT__ |
| 資料庫 | `__DB__`（本機 PostgreSQL） |

埠位由 `proj new` 分配並登記在 `~/Projects/projctl/projects.json`，**不要自己改**。
前端打的是相對路徑 `/api`，由 vite proxy 轉到後端。

第一次跑之前要先建資料庫：

```bash
createdb __DB__
psql -d __DB__ -f db/schema.sql
psql -d __DB__ -f db/seed.sql      # 假資料，可跳過
```
EOF
  else
    subst >> "$DIR/AGENTS.md" <<'EOF'

FastAPI · React + TypeScript + Vite

**這個專案目前沒有資料庫**（scaffold 跑的是 `--no-db`）。要加的時候照
`backend/app/repositories/__init__.py` 裡寫的四步走——分層目錄已經留好了，
不要為了省事把存取邏輯寫進 services 或 routers。

## Build & Run

```bash
proj start __NAME__          # 或直接 ./run.sh
```

| | |
|---|---|
| 前端 | http://localhost:__WEB_PORT__ |
| 後端 | http://localhost:__API_PORT__ |

埠位由 `proj new` 分配並登記在 `~/Projects/projctl/projects.json`，**不要自己改**。
前端打的是相對路徑 `/api`，由 vite proxy 轉到後端。
EOF
  fi

  subst >> "$DIR/AGENTS.md" <<'EOF'

## 分層規則（改程式之前先讀）

這個專案是三層的。**每一層只准往下叫，不准往上、不准跳層。**

```
frontend/src/api/client.ts   ← 前端唯一打後端的地方，component 不准直接 fetch
        ↓  HTTP
backend/app/routers/         ← 收參數、翻譯例外成狀態碼。不寫業務邏輯、不寫 SQL
        ↓
backend/app/services/        ← 業務邏輯。不 import fastapi、不 import sqlalchemy
        ↓
backend/app/repositories/    ← 唯一可以碰資料庫的地方
EOF

  if [ "$WITH_DB" = 1 ]; then
    subst >> "$DIR/AGENTS.md" <<'EOF'
        ↓
db/schema.sql                ← 資料表的唯一真相
EOF
  fi

  subst >> "$DIR/AGENTS.md" <<'EOF'
```

具體禁令，違反了就是搬錯地方：

| 這一層 | 不准做的事 |
|---|---|
| `routers/` | 寫 `if` 判斷業務規則、寫 SQL、import sqlalchemy |
| `services/` | import fastapi（不該認得 HTTPException）、寫 SQL |
| `repositories/` | 認得 HTTP、決定業務規則 |
EOF

  if [ "$WITH_DB" = 1 ]; then
    subst >> "$DIR/AGENTS.md" <<'EOF'
| `models/` vs `schemas/` | 不要拿 ORM 模型當 API 回傳型別——加一個內部欄位就會漏出去 |
EOF
  fi

  subst >> "$DIR/AGENTS.md" <<'EOF'
| 前端 component | 直接 `fetch()`。一律走 `api/client.ts` |
EOF

  if [ "$WITH_DB" = 1 ]; then
    subst >> "$DIR/AGENTS.md" <<'EOF'

**資料表改動要改兩個地方**：`db/schema.sql`（真相）與 `backend/app/models/`
（Python 這一側的對應）。刻意不用 `Base.metadata.create_all()`——它只建不
存在的表，改欄位不吭聲，本機結構會跟 schema.sql 悄悄分岔。

## 測試

```bash
cd backend && ./.venv/bin/pytest              # macOS
cd backend && ./.venv/Scripts/pytest          # Windows（Git Bash）
```

`backend/tests/test_item_service.py` 測的是 **services 這一層**——不起資料庫、
不起 HTTP，毫秒跑完。作法是把 `item_repo` 整個換成一個假的（`FakeRepo`），
而這件事之所以做得到，是因為 services 只透過 repositories 取資料。

**這是三層分層唯一的實質回報**，也是一個反向檢查：如果測試檔開始需要「先起一個
資料庫」的 fixture，表示有 SQL 漏進 services 了，該搬回 repositories。

`backend/conftest.py` 是空的，但**不能刪也不能搬**——pytest 靠它所在的位置把
`backend/` 加進 `sys.path`，`from app...` 才 import 得到。

## 示範程式碼可以刪

`items` 那條線（router / service / repository / model / schema / App.tsx）
是 scaffold 產生的範例，只為了示範分層長什麼樣。開始寫真功能時整條刪掉，
或改名沿用。

**但測試檔不要一起刪光**——留著 `FakeRepo` 那個模式，換成你真正的 service 就好。
EOF
  fi

  subst >> "$DIR/AGENTS.md" <<'EOF'

## 這些坑踩過了，別重犯

（一開始是空的。每次踩到就補一條，寫清楚症狀跟成因。）

## 做過但結論是「不做」的

**沒有留下證據的否定結果等於沒有做過**，下一個人會再查一次。試過而且量過、
結論是不做的東西寫在這裡，附上可以重跑的證據。

| 項目 | 結論 | 證據（怎麼重跑） |
|---|---|---|
| （一開始是空的） | | |
EOF
  say "AGENTS.md（分層規則跟著專案走，Codex 也讀這一份）"
fi

# ================================================================ CLAUDE.md 橋接
# 規則正本是 AGENTS.md（跨工具標準檔名），CLAUDE.md 只留一行 import。
# 這樣 Codex／Cursor／Copilot coding agent／Windsurf 跟 Claude Code 讀的是同一份。
if [ -f "$DIR/CLAUDE.md" ]; then
  echo "  · CLAUDE.md 已存在，沒有覆蓋"
else
  subst > "$DIR/CLAUDE.md" <<'EOF'
# CLAUDE.md
@AGENTS.md

<!--
規則正本是同目錄的 AGENTS.md —— 那是 Linux Foundation 底下 Agentic AI Foundation
託管的跨工具標準檔名，Codex、Cursor、Copilot coding agent、Windsurf 都原生讀它。
Claude Code 只讀 CLAUDE.md，所以用這一行 import 把正本拉進來。

要加專案規則就寫進 AGENTS.md。只有 Claude Code 專屬的工具機制才寫在這個檔案裡。
-->
EOF
  say "CLAUDE.md（一行 @AGENTS.md 橋接，Codex 也讀得到）"
fi

# ================================================================ docs/notebook.md
# 量測、推導、被推翻的假設寫這裡。它不進 context，所以放在這裡的成本是零。
# 沒有這個檔的話，那些內容會往 AGENTS.md 疊——實測會疊到兩萬行。
mkdir -p "$DIR/docs"
if [ ! -f "$DIR/docs/notebook.md" ]; then
  subst > "$DIR/docs/notebook.md" <<'EOF'
# __NAME__ 工程紀錄（engineering notebook）

**量測、推導、被推翻的假設、逐次除錯的過程寫這裡，不要寫進 `AGENTS.md`。**

理由是載入機制：`AGENTS.md` 每個 session 都會被完整讀進 context（官方建議 200 行
以內，超過會降低**所有**指令的遵從度），而這裡的內容只有真的要動對應系統時才需要。
放在這裡的 context 成本是零。

判準：

| 內容 | 放哪 |
|---|---|
| 每次都要遵守的約束、踩過的坑、使用者裁示 | `AGENTS.md` |
| 只在特定檔案相關的規則 | `.claude/rules/*.md`（要有 `paths:`） |
| **量測、推導、參數掃描、被推翻的假設** | **這裡** |
| 只給人看的考據 | 原地用 `<!-- -->` 包起來（注入 context 前會被剝除） |

每一節的標題就寫結論，不要寫主題——「拉貨週期：量過了，這個特徵族是空的」
勝過「拉貨週期分析」。半年後有人要判斷「這個還要不要重做」，看標題就夠。

## 目次

（第一筆量測寫進來時補上）
EOF
  say "docs/notebook.md（量測與推導寫這裡，不進 context）"
fi

# ================================================================ .claude/rules/
# 帶 paths: 的規則只有在 Claude 讀到符合的檔案時才載入 —— 這是唯一真的能省
# context 的拆檔方式（@path import 不會省，它一樣在啟動時展開）。
mkdir -p "$DIR/.claude/rules"
if [ "$WITH_FRONTEND" = 1 ] && [ ! -f "$DIR/.claude/rules/frontend.md" ]; then
  subst > "$DIR/.claude/rules/frontend.md" <<'EOF'
---
paths:
  - "frontend/src/**/*.{ts,tsx}"
  - "frontend/**/*.{css,html}"
---

# 前端規則（動到 frontend/ 才載入）

- **`frontend/src/api/client.ts` 是唯一打後端的地方。** 元件不要自己 `fetch`——
  那會讓「後端改了什麼」變成要全域搜尋才答得出來的問題。
- **`types.ts` 對應後端的 `schemas/`。** 後端改了 schema 就同步改這裡，
  兩邊對不上的症狀是執行期才炸，而且畫面上看起來只是「少一塊」。
- **改完要真的把畫面渲染出來看**，單元測試綠燈跟畫面沒壞是兩件事。
  做法見全域的 `~/.claude/rules/browser.md`：預設用 `dev-browser --headless`，
  不要開使用者的 Chrome 分頁。

（這是範例。專案自己的前端規則往下加，不要加到 `AGENTS.md` —— 寫在這裡的話，
不動前端的 session 完全不用付這些 token。）
EOF
  say ".claude/rules/frontend.md（帶 paths:，不動前端時零成本）"
fi

# ================================================================ project-map.json
# 作業圖：工作分類的單一真相。控制台在 /map 渲染，CLI 是 proj map。
if [ ! -f "$DIR/project-map.json" ]; then
  subst > "$DIR/project-map.json" <<'EOF'
{
  "project": "__NAME__",
  "summary": "（這個專案在做什麼、核心約束是什麼，兩三句。scaffold 填不了。）",
  "lanes": [
    { "id": "in",    "label": "輸入" },
    { "id": "logic", "label": "邏輯" },
    { "id": "store", "label": "儲存" },
    { "id": "out",   "label": "輸出" }
  ],
  "nodes": [
    { "id": "ui",      "lane": "in",    "name": "前端畫面",   "meta": "frontend/src/" },
    { "id": "client",  "lane": "in",    "name": "API client", "meta": "frontend/src/api/client.ts（唯一打後端的地方）" },
    { "id": "router",  "lane": "logic", "name": "routers",    "meta": "backend/app/routers/（HTTP 第一站，不寫業務邏輯）" },
    { "id": "service", "lane": "logic", "name": "services",   "meta": "backend/app/services/（業務邏輯，不知道 HTTP；測試打這一層）" },
    { "id": "repo",    "lane": "store", "name": "repositories", "meta": "backend/app/repositories/（唯一可以碰資料庫的地方）" },
    { "id": "db",      "lane": "store", "name": "PostgreSQL", "meta": "db/schema.sql 是資料表的唯一真相" }
  ],
  "edges": [
    ["ui", "client"],
    ["client", "router"],
    ["router", "service"],
    ["service", "repo"],
    ["repo", "db"]
  ],
  "routes": [
    {
      "id": "R1",
      "title": "起服務、確認兩個埠都通",
      "goal": "打到的是這個專案的服務，不是另一個撞埠的專案。",
      "steps": [
        { "title": "起前後端", "cmd": "proj start __NAME__      # 或 ./run.sh",
          "touches": ["ui", "router"],
          "check": "web :__WEB_PORT__ 與 api :__API_PORT__ 都在聽。",
          "trap": "撞埠的症狀是「打開網頁看到另一個專案」，而且 IPv4/IPv6 分裂時兩邊都綁得成功、不報 EADDRINUSE。" },
        { "title": "驗後端", "cmd": "curl -s localhost:__API_PORT__/health",
          "touches": ["router"],
          "check": "回 200。後端驗證用 curl，不要為此開瀏覽器。" }
      ]
    },
    {
      "id": "R2",
      "title": "改了業務邏輯之後",
      "goal": "bug 能在單元測試裡定位，不用起資料庫也不用起 HTTP。",
      "steps": [
        { "title": "跑 services 測試", "cmd": "cd backend && .venv/bin/pytest -q",
          "touches": ["service", "repo"],
          "check": "全綠。這一層用 FakeRepo，把資料庫 drop 掉照樣要能過。",
          "trap": "測試需要起資料庫＝業務邏輯漏進 repositories 或 routers 了。" },
        { "title": "跑守衛", "cmd": "bash tools/smoke.sh && python3 tools/doc-audit.py",
          "touches": ["service", "db"],
          "check": "兩支都綠。doc-audit 會抓文件裡已經不存在的路徑與指令。" }
      ]
    }
  ]
}
EOF
  say "project-map.json（作業圖：工作分類的單一真相，proj map 看得到）"
fi

# ================================================================ tools/（三道守衛）
# 這三支的存在理由：既有專案裡最貴的 bug 全是「安靜壞掉很久才被發現」那種——
# 工具跑不起來十三天沒人知道、文件寫的路徑早就不存在、數字過期而沒人重讀。
mkdir -p "$DIR/tools"

subst > "$DIR/tools/doc-audit.py" <<'PYEOF'
#!/usr/bin/env python3
"""文件腐爛偵測：規則檔與 docs/ 裡提到的路徑，現在還在不在。

    python3 tools/doc-audit.py

文件腐爛是必然的，差別只在「多久之後被發現」。2026-09-09 讓 Codex 把九個專案
讀過一遍，十四條屬實的發現裡有四條是這一類——文件寫的檔案／欄位已經不在了，
而沒有任何東西會說。這支把那個延遲壓到一個指令。

比對規則調校過三輪，每一條都對應一次誤報：

  · 跳過 glob（`.claude/rules/*.md` 不是一個檔）
  · 跳過沒有斜線又沒有副檔名的裸字（`services` 是名詞不是路徑）
  · 允許**後綴比對**——文件常寫簡稱（`api/client.ts` 指的是
    `frontend/src/api/client.ts`），那不算腐爛
  · 跳過不屬於這個 repo 的路徑（`~`、絕對路徑、`.claude/`、`projctl/`、`.projctl/`）

**沉默不等於成功**：一個路徑都沒掃到一定是比對規則壞了，不是文件很乾淨，
所以那種情況 exit 2 並明說結果不可信。

剩下的誤報全是同一種：**文件正在講那個路徑「不存在」**——反面示範
（「不要用 `plugins/echarts.client.ts` 這樣做」）、搬走之前的舊位置、
還沒建起來的檔、別的 repo 的檔。正則分不出這件事，所以走 `doc-audit-allow.txt`。

那個檔**會自己過期**：例外裡的路徑哪天真的出現了、或是它在文件裡的那句話
被刪了，這支就報錯要人回來清。**一個永遠紅的檢查等於沒有檢查，而一個
永遠綠的例外清單等於沒有檢查的另一半**——例外一旦寫下就不再有人看它是否
還成立，於是它會慢慢把真的腐爛也蓋掉。
"""

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

# **只掃每個 session 都會載入的規則檔。**
#
# 刻意不掃 docs/ —— notebook 與各種 dev-analysis 是**檔案庫**，它們本來就在描述
# 過去的結構（News 的 dev-analysis.md 講的是 2026-08-07 移除的 Streamlit views/）。
# 把它們算進來的話，這支工具會為了「歷史文件描述歷史」而永遠是紅的，
# 而一個永遠紅的檢查等於沒有檢查。
#
# 這支要問的是：**現在每次都被讀進去的那份規則，還對得上程式碼嗎。**
DOCS = [p for p in (ROOT / "AGENTS.md", ROOT / "CLAUDE.md") if p.exists()]

PATH_RE = re.compile(r"`([^`\n]+)`")

ALLOW_FILE = ROOT / "tools" / "doc-audit-allow.txt"


def _allow():
    """讀例外清單：每行 `路徑  # 為什麼它不該存在`。理由是必填的。"""
    out = {}
    if not ALLOW_FILE.exists():
        return out
    for n, line in enumerate(ALLOW_FILE.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        path, _, why = line.partition("#")
        path, why = path.strip(), why.strip()
        if not why:
            raise SystemExit(
                f"{ALLOW_FILE.name}:{n} 只寫了路徑沒寫理由。\n"
                "沒有理由的例外，下一個人看到時無從判斷它還成不成立，"
                "而那正是例外清單開始蓋掉真腐爛的那一刻。"
            )
        out[path] = why
    return out


ALLOWED = _allow()

# 每一條都對應一次實測到的誤報，不要憑感覺放寬或收緊：
#   `lineWidth/2`                    算式，不是路徑
#   `<span></span>`                  HTML
#   `Docker.app/.../bin`             省略過的路徑
#   `%USERPROFILE%\.agent-quota\…`   Windows 環境變數
#   `bruuucechang/projctl`           GitHub repo 代稱
#   `backend/app/database.py:7`      file:line（要先剝掉 :7）
#   `.env` / `backend/ledger.db`     gitignore 的執行期產物
SKIP = re.compile(
    r"^(https?:|__|\$|-|#|%)"      # URL、樣板變數、指令、環境變數
    r"|\s|\*"                      # 空白、glob
    r"|[<>\\|]"                    # HTML、Windows 路徑分隔、管線
    r"|\.\.\."                      # 省略號
    r"|^[A-Za-z][A-Za-z0-9]*/\d+$"  # lineWidth/2 這種算式
)
EXT = (".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".swift", ".sql", ".json", ".jsonc",
       ".md", ".sh", ".cmd", ".toml", ".ini", ".yml", ".yaml", ".plist", ".html", ".css",
       ".vue", ".mts", ".xcodeproj", ".txt", ".env")
EXTERNAL = ("~", "/", ".claude/", "projctl/", ".projctl/", ".codex/")

ALL = [
    str(p.relative_to(ROOT))
    for p in ROOT.rglob("*")
    if p.is_file()
    and not any(part in {".git", "node_modules", ".venv", "dist", "build", "__pycache__",
                         ".next", ".nuxt", "DerivedData"} for part in p.parts)
]

def _gitignored(paths):
    """一次問 git 哪些是被忽略的——執行期產物不存在是正常的，不是文件腐爛。"""
    if not paths:
        return set()
    try:
        import subprocess
        r = subprocess.run(["git", "-C", str(ROOT), "check-ignore", "--stdin"],
                           input="\n".join(paths), capture_output=True, text=True, timeout=20)
        return set(r.stdout.split("\n")) - {""}
    except Exception:
        return set()


# 先收集所有候選，一次問 git，避免每個路徑各開一支程序
_cands = set()
for _doc in DOCS:
    for _raw in PATH_RE.findall(_doc.read_text(encoding="utf-8", errors="ignore")):
        _s = re.sub(r":\d+(-\d+)?$", "", _raw.strip().rstrip("/"))
        if not SKIP.search(_s) and not _s.startswith(EXTERNAL):
            _cands.add(_s)
ignored = _gitignored(sorted(_cands))

missing, checked = [], 0
stale, seen_allowed = [], set()
for doc in DOCS:
    for raw in PATH_RE.findall(doc.read_text(encoding="utf-8", errors="ignore")):
        s = raw.strip().rstrip("/")
        s = re.sub(r":\d+(-\d+)?$", "", s)      # file:line / file:12-20
        if SKIP.search(s) or s.startswith(EXTERNAL):
            continue
        # 一定要看起來像這個 repo 裡的檔：有已知副檔名，或是一段存在的目錄路徑
        if not (s.endswith(EXT) or (ROOT / s).is_dir()):
            continue
        if s in ignored:                        # gitignore 的執行期產物不算腐爛
            continue
        checked += 1
        here = (ROOT / s).exists() or any(a == s or a.endswith("/" + s) for a in ALL)
        if s in ALLOWED:
            seen_allowed.add(s)
            if here:
                stale.append((s, ALLOWED[s], "它現在存在了"))
            continue
        if not here:
            missing.append((doc.name, s))

for a, why in ALLOWED.items():
    if a not in seen_allowed:
        stale.append((a, why, "文件裡已經沒有提到它了"))

if checked == 0:
    print("✗ 一個路徑都沒掃到 —— 比對規則八成壞了，這次結果不可信", file=sys.stderr)
    sys.exit(2)

if stale:
    print(f"✗ {ALLOW_FILE.relative_to(ROOT)} 有 {len(stale)} 條例外過期了 —— 例外要跟著文件走：")
    for a, why, cause in stale:
        print(f"    `{a}`（原本的理由：{why}）—— {cause}")
    print("  把它從例外清單移掉。留著的話它會蓋掉之後真的發生在這個路徑上的腐爛。")
    sys.exit(1)

if missing:
    for d, s in missing:
        print(f"✗ {d} 提到 `{s}`，但它不存在")
    print(f"\n掃了 {checked} 個路徑，{len(missing)} 個已經不在了。")
    sys.exit(1)

_ex = f"，另有 {len(ALLOWED)} 個記在例外清單" if ALLOWED else ""
print(f"{len(DOCS)} 份文件裡的 {checked} 個路徑都還在{_ex}。")
PYEOF
chmod +x "$DIR/tools/doc-audit.py"

subst > "$DIR/tools/doc-audit-allow.txt" <<'TXTEOF'
# doc-audit 的例外：文件「正在講這個路徑不存在」的那些 —— 反面示範
#（「不要用 X 這樣做」）、搬走之前的舊位置、還沒建的檔、別的 repo 的檔。
# 正則分不出這件事，所以在這裡逐條寫下來。
#
# 格式 `路徑  # 為什麼它不該存在`。理由是必填的，沒理由的例外，下一個人
# 看到時無從判斷它還成不成立，而那正是例外清單開始蓋掉真腐爛的那一刻。
#
# 這個清單會自己過期：例外裡的路徑真的出現了、或它在文件裡那句話被刪了，
# doc-audit 就會報錯要人回來清。

TXTEOF

subst > "$DIR/tools/smoke.sh" <<'SHEOF'
#!/usr/bin/env bash
# 每一支工具還跑不跑得起來？（最小工作量，不驗結果只驗「不會炸」）
#
# 存在的理由：工具壞掉是安靜的。它不在測試裡、平常也沒人跑，所以可以壞很久
# 而沒有任何人知道——實際發生過十三天。這支把「安靜」變成「紅燈」。
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0; n=0

check() { n=$((n+1)); if eval "$1" >/dev/null 2>&1; then printf '  ✓ %s\n' "$2"; else printf '  ✗ %s\n' "$2"; fail=$((fail+1)); fi; }

echo "冒煙測試"
check "[ -x run.sh ]"                              "run.sh 可執行"
check "python3 tools/doc-audit.py"                 "tools/doc-audit.py"
check "python3 -c 'import json;json.load(open(\"project-map.json\"))'" "project-map.json 是合法 JSON"
check "[ -f db/schema.sql ] || true"               "db/schema.sql"
check "python3 -c 'import ast,sys;[ast.parse(open(p).read()) for p in __import__(\"glob\").glob(\"backend/app/**/*.py\",recursive=True)]'" "backend 全部 .py 語法正確"

# 沉默不等於成功
if [ "$n" -lt 3 ]; then
  echo "✗ 只跑了 $n 項檢查——這支腳本八成壞了"; exit 2
fi
echo
if [ "$fail" -gt 0 ]; then echo "$n 項裡 $fail 項失敗。"; exit 1; fi
echo "$n 項全過。"
SHEOF
chmod +x "$DIR/tools/smoke.sh"

subst > "$DIR/tools/vitals.py" <<'PYEOF'
#!/usr/bin/env python3
"""文件裡引用的數字，一個指令全部重跑。

存在的理由：寫在文件裡的數字不會自己更新，而底下的東西一直在動。
**文件上的數字跟這支的輸出對不上，它就是過期的** —— 不一定當初錯，
是現在不該再引用。新增一個會被寫進文件的數字，就在這裡加一行。

    python3 tools/vitals.py
"""
import pathlib, subprocess, glob

ROOT = pathlib.Path(__file__).resolve().parent.parent


def lines(pattern):
    return sum(len(open(p, encoding="utf-8", errors="ignore").readlines())
               for p in glob.glob(str(ROOT / pattern), recursive=True))


def count(pattern):
    return len(glob.glob(str(ROOT / pattern), recursive=True))


print(f"# __NAME__ vitals")
print()
print(f"{'測試檔':<22}{count('backend/tests/test_*.py') + count('frontend/**/*.test.ts*'):>8}")
print(f"{'routers':<22}{count('backend/app/routers/*.py') - 1:>8}")
print(f"{'services':<22}{count('backend/app/services/*.py') - 1:>8}")
print(f"{'repositories':<22}{count('backend/app/repositories/*.py') - 1:>8}")
print(f"{'backend 行數':<20}{lines('backend/app/**/*.py'):>8}")
print(f"{'frontend 行數':<19}{lines('frontend/src/**/*.ts*'):>8}")
print(f"{'AGENTS.md 行數':<19}{lines('AGENTS.md'):>8}   （官方目標 200 以內）")
print(f"{'notebook 行數':<20}{lines('docs/notebook.md'):>8}   （這一份不進 context）")
PYEOF
chmod +x "$DIR/tools/vitals.py"
say "tools/（doc-audit · smoke · vitals：三道會大聲失敗的守衛）"

# ================================================================ 建資料庫
if [ "$WITH_DB" = 1 ] && [ "$WITH_CREATEDB" = 1 ]; then
  if ! command -v createdb >/dev/null 2>&1; then
    echo "  · 找不到 createdb，跳過建資料庫（brew services start postgresql@17）"
  elif psql -lqt 2>/dev/null | cut -d'|' -f1 | grep -qw "$DB"; then
    echo "  · 資料庫 $DB 已存在，沒有重建"
  else
    createdb "$DB"
    psql -q -d "$DB" -f "$DIR/db/schema.sql"
    psql -q -d "$DB" -f "$DIR/db/seed.sql"
    say "資料庫 ${DB}（schema + seed 已套用）"
  fi
fi

# ================================================================ 修正登錄表
# proj new 寫進去的 start 是 `npm run dev`（newproject.mjs:128），
# 對前後端分離的專案是錯的：它只會起前端，後端沒人管。
if [ "$WITH_REGISTRY" = 1 ] && [ -f "$REGISTRY" ]; then
  node -e '
    const fs = require("fs");
    const [file, name, withDb] = process.argv.slice(1);
    const reg = JSON.parse(fs.readFileSync(file, "utf8"));
    const p = reg.projects.find((x) => x.name === name);
    if (!p) { console.log("  · projects.json 裡沒有這筆，跳過修正"); process.exit(0); }
    p.start = "./run.sh";
    if (withDb === "1" && !(p.deps || []).includes("postgres")) {
      p.deps = [...(p.deps || []), "postgres"];
    }
    fs.writeFileSync(file, JSON.stringify(reg, null, 2) + "\n");
    console.log("  \x1b[32m✓\x1b[0m projects.json：start → ./run.sh" +
      (withDb === "1" ? "、deps → postgres" : ""));
  ' "$REGISTRY" "$NAME" "$WITH_DB"
fi

# ================================================================
cat <<EOF

  好了。

    cd $DIR
    proj start $NAME

  前端 http://localhost:$WEB_PORT   後端 http://localhost:$API_PORT/health

  分層規則寫在 $DIR/AGENTS.md，動程式之前先讀（CLAUDE.md 是一行 import 的橋接）。
EOF
