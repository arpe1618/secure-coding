#!/usr/bin/env bash
# 다시장 자동 테스트 (E2E)
# 사용법: 서버를 켜둔 상태에서  →  bash tests/e2e.sh
#   ※ 깨끗한 DB에서 실행하세요 (data/ 폴더 비우고 서버 재시작).
#   ※ .env의 ADMIN_PASSWORD가 admin1234가 아니면 아래 ADMIN_PW를 바꾸세요.
B="${1:-http://localhost:3000}/api"
ADMIN_PW="${ADMIN_PW:-admin1234}"
PASS=0; FAIL=0
ok(){ echo "  ✅ $1"; PASS=$((PASS+1)); }
no(){ echo "  ❌ $1  (실제값: $2)"; FAIL=$((FAIL+1)); }
chk(){ [ "$2" = "$3" ] && ok "$1" || no "$1" "$2"; }
jget(){ python3 -c "import sys,json
try: d=json.load(sys.stdin); print(d$1)
except Exception as e: print('PARSE_ERR')"; }

echo "[1] 회원가입/로그인"
T1=$(curl -s -X POST $B/auth/signup -H 'Content-Type: application/json' -d '{"name":"테스트A","password":"pass1234"}' | jget "['token']")
T2=$(curl -s -X POST $B/auth/signup -H 'Content-Type: application/json' -d '{"name":"테스트B","password":"pass1234"}' | jget "['token']")
T3=$(curl -s -X POST $B/auth/signup -H 'Content-Type: application/json' -d '{"name":"테스트C","password":"pass1234"}' | jget "['token']")
T4=$(curl -s -X POST $B/auth/signup -H 'Content-Type: application/json' -d '{"name":"악성테스트","password":"pass1234"}' | jget "['token']")
[ ${#T1} -gt 20 ] && ok "회원가입 및 토큰 발급" || no "회원가입" "$T1"
DUP=$(curl -s -X POST $B/auth/signup -H 'Content-Type: application/json' -d '{"name":"테스트A","password":"x1234"}' | jget "['error']")
chk "아이디 중복 거절" "$DUP" "이미 사용 중인 닉네임입니다."
BAD=$(curl -s -X POST $B/auth/login -H 'Content-Type: application/json' -d '{"name":"테스트A","password":"wrong"}' | jget "['error']")
chk "틀린 비밀번호 거절" "$BAD" "닉네임 또는 비밀번호가 맞지 않습니다."
TA=$(curl -s -X POST $B/auth/login -H 'Content-Type: application/json' -d "{\"name\":\"admin\",\"password\":\"$ADMIN_PW\"}" | jget "['token']")
[ ${#TA} -gt 20 ] && ok "관리자 로그인" || no "관리자 로그인" "$TA"

echo "[2] 마이페이지 (소개글·비밀번호)"
BIO=$(curl -s -X PUT $B/auth/me -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -d '{"bio":"테스트 소개글"}' | jget "['bio']")
chk "소개글 저장" "$BIO" "테스트 소개글"
PW=$(curl -s -X PUT $B/auth/password -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -d '{"old_password":"pass1234","new_password":"newpw99"}' | jget "['ok']")
chk "비밀번호 변경" "$PW" "True"
RE=$(curl -s -X POST $B/auth/login -H 'Content-Type: application/json' -d '{"name":"테스트A","password":"newpw99"}' | jget "['user']['name']")
chk "새 비밀번호로 로그인" "$RE" "테스트A"

echo "[3] 상품 등록/조회/검색/상세"
P1=$(curl -s -X POST $B/products -H "Authorization: Bearer $T2" -F title="테스트 에어팟" -F price=50000 -F category=디지털 -F description="테스트용" | jget "['id']")
[ "$P1" != "PARSE_ERR" ] && ok "상품 등록 (id=$P1)" || no "상품 등록" "$P1"
CNT=$(curl -s "$B/products?q=%EC%97%90%EC%96%B4%ED%8C%9F" -H "Authorization: Bearer $T1" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['products']))")
chk "키워드 검색" "$CNT" "1"
TITLE=$(curl -s $B/products/$P1 -H "Authorization: Bearer $T1" | jget "['product']['title']")
chk "상세 페이지 조회" "$TITLE" "테스트 에어팟"

echo "[4] 사용자 조회 (프로필)"
UID1=$(curl -s $B/auth/me -H "Authorization: Bearer $T1" | jget "['user']['id']")
PBIO=$(curl -s $B/users/$UID1 -H "Authorization: Bearer $T2" | jget "['user']['bio']")
chk "다른 유저 프로필(소개글) 조회" "$PBIO" "테스트 소개글"

echo "[5] 채팅 (1대1 + 전체)"
CID=$(curl -s -X POST $B/chats -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -d "{\"product_id\":$P1}" | jget "['chat_id']")
curl -s -X POST $B/chats/$CID/messages -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -d '{"text":"판매중?"}' >/dev/null
curl -s -X POST $B/chats/$CID/messages -H "Authorization: Bearer $T2" -H 'Content-Type: application/json' -d '{"text":"네!"}' >/dev/null
MC=$(curl -s $B/chats/$CID/messages -H "Authorization: Bearer $T1" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['messages']))")
chk "1대1 채팅 송수신" "$MC" "2"
OUT=$(curl -s $B/chats/$CID/messages -H "Authorization: Bearer $T3" | jget "['error']")
chk "제3자 대화방 접근 거절" "$OUT" "참여 중인 대화방이 아닙니다."
curl -s -X POST $B/global-chat -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -d '{"text":"전체 채팅 테스트"}' >/dev/null
GC=$(curl -s $B/global-chat -H "Authorization: Bearer $T3" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['messages']))")
[ "$GC" -ge 1 ] && ok "전체 채팅 송수신" || no "전체 채팅" "$GC"

echo "[6] 지갑 (충전·송금·에스크로)"
ON=$(curl -s -X POST $B/payments/charges -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -d '{"amount":100000}' | jget "['order_no']")
curl -s -X POST $B/payments/charges/mock-confirm -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -d "{\"order_no\":\"$ON\"}" >/dev/null
BAL=$(curl -s $B/auth/me -H "Authorization: Bearer $T1" | jget "['user']['balance']")
chk "지갑 충전" "$BAL" "100000"
curl -s -X POST $B/payments/charges/mock-confirm -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -d "{\"order_no\":\"$ON\"}" >/dev/null
BAL2=$(curl -s $B/auth/me -H "Authorization: Bearer $T1" | jget "['user']['balance']")
chk "중복 승인 방지 (잔액 그대로)" "$BAL2" "100000"
OID=$(curl -s -X POST $B/wallet/orders -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -d "{\"product_id\":$P1}" | jget "['order']['id']")
[ "$OID" != "PARSE_ERR" ] && ok "에스크로 구매" || no "에스크로 구매" "$OID"
SB0=$(curl -s $B/auth/me -H "Authorization: Bearer $T2" | jget "['user']['balance']")
chk "확정 전 판매자 잔액 0 (에스크로 보관)" "$SB0" "0"
curl -s -X POST $B/wallet/orders/$OID/confirm -H "Authorization: Bearer $T1" >/dev/null
SB1=$(curl -s $B/auth/me -H "Authorization: Bearer $T2" | jget "['user']['balance']")
chk "구매 확정 후 판매자 정산" "$SB1" "50000"
NEG=$(curl -s -X POST $B/wallet/transfer -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -d '{"to_name":"테스트B","amount":99999999}' | jget "['error']")
chk "잔액 초과 송금 거절" "$NEG" "잔액이 부족합니다."
ZERO=$(curl -s -X POST $B/wallet/transfer -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -d '{"to_name":"테스트B","amount":-500}' | jget "['error']")
chk "음수 금액 거절" "$ZERO" "금액을 확인해 주세요."

echo "[7] 신고 → 자동 제재 (임계값: 서로 다른 3명)"
PB=$(curl -s -X POST $B/products -H "Authorization: Bearer $T4" -F title="가짜상품" -F price=9900 -F category=패션 | jget "['id']")
for T in $T1 $T2; do curl -s -X POST $B/reports -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d "{\"kind\":\"product\",\"target_id\":$PB,\"reason\":\"사기\"}" >/dev/null; done
A3=$(curl -s -X POST $B/reports -H "Authorization: Bearer $T3" -H 'Content-Type: application/json' -d "{\"kind\":\"product\",\"target_id\":$PB,\"reason\":\"사기\"}" | jget "['auto_sanctioned']")
chk "3번째 신고에서 상품 자동 차단" "$A3" "True"
UID4=$(curl -s $B/auth/me -H "Authorization: Bearer $T4" | jget "['user']['id']")
for T in $T1 $T2 $T3; do curl -s -X POST $B/reports -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d "{\"kind\":\"user\",\"target_id\":$UID4,\"reason\":\"사기\"}" >/dev/null; done
DORM=$(curl -s -X POST $B/auth/login -H 'Content-Type: application/json' -d '{"name":"악성테스트","password":"pass1234"}' | jget "['error']")
chk "신고 누적 유저 휴면 전환 (로그인 거절)" "$DORM" "신고 누적으로 휴면계정 전환되었습니다. 관리자에게 문의하세요."

echo "[8] 관리자 권한/기능"
FORB=$(curl -s $B/admin/summary -H "Authorization: Bearer $T1" | jget "['error']")
chk "일반 유저의 관리자 API 거절" "$FORB" "관리자 권한이 필요합니다."
curl -s -X POST $B/admin/users/$UID4/dormant -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d '{"dormant":0}' >/dev/null
WAKE=$(curl -s -X POST $B/auth/login -H 'Content-Type: application/json' -d '{"name":"악성테스트","password":"pass1234"}' | jget "['user']['name']")
chk "관리자 휴면 해제 후 재로그인" "$WAKE" "악성테스트"

echo "[9] 브루트 포스 방어"
curl -s -X POST $B/auth/signup -H 'Content-Type: application/json' -d '{"name":"브루트대상","password":"real1234"}' >/dev/null
for i in 1 2 3 4 5; do curl -s -X POST $B/auth/login -H 'Content-Type: application/json' -d '{"name":"브루트대상","password":"wrong"}' >/dev/null; done
LOCK=$(curl -s -X POST $B/auth/login -H 'Content-Type: application/json' -d '{"name":"브루트대상","password":"wrong"}' | jget "['error'][:16]")
chk "5회 실패 후 잠금 (429)" "$LOCK" "로그인 시도가 너무 많습니다."
LOCK2=$(curl -s -X POST $B/auth/login -H 'Content-Type: application/json' -d '{"name":"브루트대상","password":"real1234"}' | jget "['error'][:16]")
chk "잠금 중엔 맞는 비밀번호도 거절" "$LOCK2" "로그인 시도가 너무 많습니다."

echo
echo "결과: 통과 $PASS / 실패 $FAIL"
[ $FAIL -eq 0 ] && echo "🎉 모든 테스트 통과!" || echo "⚠️ 실패한 항목을 확인하세요."
exit $FAIL
