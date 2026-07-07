#!/usr/bin/env bash
# 다시장 자동 테스트 (E2E)
# 사용법: 서버를 켜둔 상태에서  →  bash tests/e2e.sh
#   ※ 깨끗한 DB에서 실행하세요 (data/ 폴더 비우고 서버 재시작).
#   ※ .env의 ADMIN_PASSWORD가 admin1234가 아니면 아래 ADMIN_PW를 바꾸세요.
#   ※ 테스트는 한 IP에서 수백 건을 보내므로, 전역 레이트 리밋에 걸리지 않게
#      서버를 API_RATE_LIMIT_PER_MIN=100000 로 띄운 상태에서 실행하세요.
#      예)  API_RATE_LIMIT_PER_MIN=100000 npm start
ROOT="${1:-http://localhost:3000}"
B="$ROOT/api"
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
ZERO=$(curl -s -X POST $B/wallet/transfer -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -d '{"to_name":"테스트B","amount":-500}' | jget "['error'][:2]")
chk "음수 금액 거절" "$ZERO" "금액"

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

echo "[9] 브루트 포스 방어 (IP 기준)"
curl -s -X POST $B/auth/signup -H 'Content-Type: application/json' -d '{"name":"브루트대상","password":"real1234"}' >/dev/null
# 공격자 IP(198.51.100.7)를 흉내내 10회 실패 → 그 IP만 429로 제한 (실제 테스트 IP는 영향 없음)
ATK='X-Forwarded-For: 198.51.100.7'
for i in $(seq 1 10); do curl -s -X POST $B/auth/login -H "$ATK" -H 'Content-Type: application/json' -d '{"name":"브루트대상","password":"wrong"}' >/dev/null; done
LOCK=$(curl -s -X POST $B/auth/login -H "$ATK" -H 'Content-Type: application/json' -d '{"name":"브루트대상","password":"wrong"}' | jget "['error'][:6]")
chk "10회 실패 후 해당 IP 제한 (429)" "$LOCK" "이 위치에서"
# 계정 잠금 DoS 방지: 공격받은 계정을 '다른 IP'의 주인은 정상 로그인 (IP 제한이므로 계정은 멀쩡)
VICTIM=$(curl -s -X POST $B/auth/login -H 'X-Forwarded-For: 203.0.113.55' -H 'Content-Type: application/json' -d '{"name":"브루트대상","password":"real1234"}' | jget "['user']['name']")
chk "다른 위치의 피해자 본인은 정상 로그인 (계정잠금 DoS 없음)" "$VICTIM" "브루트대상"

echo "[10] 보안 진단서 대응 검증"
# §1 위장 파일: 내용은 HTML인데 확장자·MIME만 이미지인 파일 → 거절
printf '<script>alert(1)</script>' > /tmp/evil.jpg
EVIL=$(curl -s -X POST $B/products -H "Authorization: Bearer $T1" -F title="위장파일" -F price=1000 -F category=기타 -F "image=@/tmp/evil.jpg;type=image/jpeg" | jget "['error'][:3]")
chk "위장 파일(가짜 이미지) 업로드 거절" "$EVIL" "jpg"
# 진짜 PNG(매직 바이트 정상)는 통과해야 함
printf '\x89\x50\x4e\x47\x0d\x0a\x1a\x0a' > /tmp/real.png
REAL=$(curl -s -X POST $B/products -H "Authorization: Bearer $T1" -F title="정상이미지" -F price=1000 -F category=기타 -F "image=@/tmp/real.png;type=image/png" | jget "['id']")
[ "$REAL" != "PARSE_ERR" ] && ok "정상 이미지 업로드 통과" || no "정상 이미지 업로드" "$REAL"
# §4 1일 등록 한도 (기본 30개)
curl -s -X POST $B/auth/signup -H 'Content-Type: application/json' -d '{"name":"도배유저","password":"pass1234"}' >/dev/null
TD=$(curl -s -X POST $B/auth/login -H 'Content-Type: application/json' -d '{"name":"도배유저","password":"pass1234"}' | jget "['token']")
for i in $(seq 1 30); do curl -s -X POST $B/products -H "Authorization: Bearer $TD" -F title="도배$i" -F price=1000 -F category=기타 >/dev/null; done
OVER=$(curl -s -X POST $B/products -H "Authorization: Bearer $TD" -F title="도배31" -F price=1000 -F category=기타 | jget "['error'][:11]")
chk "31번째 등록 거절 (1일 한도 30)" "$OVER" "하루 등록 한도(30"
# §2 httpOnly 쿠키 세션: 쿠키만으로 인증 + 로그아웃 후 무효화 (+ CSRF 헤더)
curl -s -c /tmp/ck.txt -X POST $B/auth/login -H 'Content-Type: application/json' -d '{"name":"도배유저","password":"pass1234"}' >/dev/null
CK=$(curl -s -b /tmp/ck.txt $B/auth/me | jget "['user']['name']")
chk "쿠키만으로 인증 성공" "$CK" "도배유저"
grep -q "HttpOnly" /tmp/ck.txt && ok "쿠키에 HttpOnly 플래그" || no "HttpOnly 플래그" "없음"
# CSRF 방어: 쿠키 인증 상태변경 요청은 헤더 없으면 403, 있으면 통과
NOCSRF=$(curl -s -b /tmp/ck.txt -X POST $B/auth/logout -o /dev/null -w "%{http_code}")
chk "CSRF 헤더 없는 상태변경 요청 차단 (403)" "$NOCSRF" "403"
CSRF=$(grep -oE "csrf[[:space:]]+[a-f0-9]+" /tmp/ck.txt | awk '{print $2}')
curl -s -b /tmp/ck.txt -c /tmp/ck.txt -X POST $B/auth/logout -H "X-CSRF-Token: $CSRF" >/dev/null
OUT2=$(curl -s -b /tmp/ck.txt $B/auth/me | jget "['error'][:4]")
chk "CSRF 헤더 포함 로그아웃 후 쿠키 무효화" "$OUT2" "로그인이"
# §3 페이징: page 파라미터 동작
PGN=$(curl -s "$B/admin/products?page=999" -H "Authorization: Bearer $TA" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['products']))")
chk "페이징: 존재하지 않는 페이지는 빈 목록" "$PGN" "0"

echo "[11] 남용·우회 교차검증 (2차 진단)"
# 금액 검증: 지수표기/문자열/과대 금액 차단
E1=$(curl -s -X POST $B/wallet/transfer -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -d '{"to_name":"테스트B","amount":1e300}' | jget "['error'][:2]")
chk "지수표기 금액(1e300) 거절" "$E1" "금액"
E2=$(curl -s -X POST $B/wallet/transfer -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -d '{"to_name":"테스트B","amount":"99999999999"}' | jget "['error'][:2]")
chk "한도 초과 문자열 금액 거절" "$E2" "금액"
# 페이징 정수 오버플로우로 서버가 죽지 않아야 함 (500 금지)
PG=$(curl -s "$B/admin/products?page=99999999999999999999" -H "Authorization: Bearer $TA" -o /dev/null -w "%{http_code}")
chk "거대 page 값에도 서버 정상(200)" "$PG" "200"
# 업로드 용량 초과는 500이 아닌 413으로
head -c 6000000 /dev/urandom > /tmp/toobig.bin
BIG=$(curl -s -X POST $B/products -H "Authorization: Bearer $T1" -F title=t -F price=1 -F category=기타 -F "image=@/tmp/toobig.bin" -o /dev/null -w "%{http_code}" --max-time 20)
chk "5MB 초과 업로드 413 (크래시 아님)" "$BIG" "413"
# 전체 채팅 도배 방지: 20연속 전송 중 대부분 429
curl -s -X POST $B/auth/signup -H 'Content-Type: application/json' -d '{"name":"도배봇","password":"pass1234"}' >/dev/null
TS=$(curl -s -X POST $B/auth/login -H 'Content-Type: application/json' -d '{"name":"도배봇","password":"pass1234"}' | jget "['token']")
SUC=0; for i in $(seq 1 20); do R=$(curl -s -X POST $B/global-chat -H "Authorization: Bearer $TS" -H 'Content-Type: application/json' -d '{"text":"spam"}' -o /dev/null -w "%{http_code}"); [ "$R" = "201" ] && SUC=$((SUC+1)); done
[ "$SUC" -le 8 ] && ok "전체채팅 도배 차단 (20연속 중 $SUC건만 통과)" || no "전체채팅 도배 차단" "$SUC건 통과"

echo "[12] 정적검토 후속 조치 검증"
# 자기 신고 차단
SELFU=$(curl -s -X POST $B/reports -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -d "{\"kind\":\"user\",\"target_id\":$UID1,\"reason\":\"자기신고\"}" | jget "['error'][:2]")
chk "자기 자신 신고 차단" "$SELFU" "자기"
# 본인 상품 신고 차단 (T2가 올린 상품 P1을 T2가 신고)
SELFP=$(curl -s -X POST $B/reports -H "Authorization: Bearer $T2" -H 'Content-Type: application/json' -d "{\"kind\":\"product\",\"target_id\":$P1,\"reason\":\"본인상품\"}" | jget "['error'][:2]")
chk "본인 상품 신고 차단" "$SELFP" "본인"
# 중복 신고 차단 (T1이 P1을 두 번 신고)
curl -s -X POST $B/reports -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -d "{\"kind\":\"product\",\"target_id\":$P1,\"reason\":\"1차\"}" >/dev/null
DUP=$(curl -s -X POST $B/reports -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -d "{\"kind\":\"product\",\"target_id\":$P1,\"reason\":\"2차\"}" | jget "['error'][:2]")
chk "동일인 중복 신고 차단" "$DUP" "이미"
# 관리자 신고 차단 (관리자를 유저 신고)
AID2=$(curl -s -X POST $B/auth/login -H 'Content-Type: application/json' -d "{\"name\":\"admin\",\"password\":\"$ADMIN_PW\"}" | jget "['user']['id']")
ADMR=$(curl -s -X POST $B/reports -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -d "{\"kind\":\"user\",\"target_id\":$AID2,\"reason\":\"관리자신고\"}" | jget "['error'][:2]")
chk "관리자는 신고 대상 아님 (404)" "$ADMR" "신고"

echo "[13] 시큐어코딩 강화 검증 (전역 방어)"
# 보안 헤더 존재
HDRS=$(curl -s -D - -o /dev/null "$ROOT/" )
echo "$HDRS" | grep -qi "X-Frame-Options: DENY" && ok "X-Frame-Options 헤더" || no "X-Frame-Options" "없음"
echo "$HDRS" | grep -qi "Content-Security-Policy" && ok "CSP 헤더" || no "CSP" "없음"
echo "$HDRS" | grep -qi "x-powered-by" && no "x-powered-by 제거" "노출됨" || ok "x-powered-by 헤더 제거됨"
# 잘못된 JSON → 스택 노출 없이 400
BADJSON=$(curl -s -X POST $B/auth/login -H 'Content-Type: application/json' -d '{bad' | jget "['error']")
[ -n "$BADJSON" ] && case "$BADJSON" in *SyntaxError*|*at\ *|*node_modules*) no "에러 스택 미노출" "$BADJSON";; *) ok "잘못된 JSON에 스택 미노출 (일반 문구)";; esac
# 거대 바디 → 413
BIG=$(python3 -c "print('{\"name\":\"x\",\"password\":\"'+'A'*2000000+'\"}')" | curl -s -X POST $B/auth/login -H 'Content-Type: application/json' --data @- -o /dev/null -w "%{http_code}" --max-time 10)
chk "1MB 초과 요청 본문 차단 (413)" "$BIG" "413"

echo
echo "결과: 통과 $PASS / 실패 $FAIL"
[ $FAIL -eq 0 ] && echo "🎉 모든 테스트 통과!" || echo "⚠️ 실패한 항목을 확인하세요."
exit $FAIL
