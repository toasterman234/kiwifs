package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/labstack/echo/v4"
)

type autolithBuffer struct{ bytes.Buffer }
func (b *autolithBuffer) Close() error { return nil }

func autolithTestBridge() *autolithBridge {
	return &autolithBridge{
		access:strings.Repeat("q",32), workdir:"/tmp",binary:"autolith",
		pending:make(map[uint64]chan autolithRPCResult),
		sessions:map[string]*autolithSession{
			"one":{ID:"one",Title:"Autolith · Chat",Messages:[]*autolithChatMessage{}},
		},
		permissions:make(map[string]*autolithPermission),
		input:&autolithBuffer{},
	}
}
func TestAutolithACPConfigurationFailClosed(t *testing.T) {
	t.Setenv("KIWIFS_AGENT_AUTOLITH_ENABLED","0")
	t.Setenv("KIWIFS_AGENT_ACCESS_TOKEN",strings.Repeat("a",32))
	t.Setenv("KIWIFS_AGENT_AUTOLITH_WORKDIR",t.TempDir())
	if autolithBridgeFromEnvironment()!=nil {t.Fatal("disabled Autolith was registered")}
	t.Setenv("KIWIFS_AGENT_AUTOLITH_ENABLED","1")
	t.Setenv("KIWIFS_AGENT_ACCESS_TOKEN","short")
	if autolithBridgeFromEnvironment()!=nil {t.Fatal("short chat key accepted")}
	t.Setenv("KIWIFS_AGENT_ACCESS_TOKEN",strings.Repeat("a",32))
	t.Setenv("KIWIFS_AGENT_AUTOLITH_WORKDIR","relative/path")
	if autolithBridgeFromEnvironment()!=nil {t.Fatal("relative working directory accepted")}
	t.Setenv("KIWIFS_AGENT_AUTOLITH_WORKDIR",t.TempDir())
	t.Setenv("KIWIFS_AGENT_AUTOLITH_BIN","arbitrary-wrapper")
	if autolithBridgeFromEnvironment()!=nil {t.Fatal("non-absolute untrusted executable allowed")}
	binary:=filepath.Join(t.TempDir(),"autolith")
	if err:=os.WriteFile(binary,[]byte("#!/bin/sh\nexit 0\n"),0700);err!=nil{t.Fatal(err)}
	t.Setenv("KIWIFS_AGENT_AUTOLITH_BIN",binary)
	if autolithBridgeFromEnvironment()==nil {t.Fatal("correctly configured bridge rejected")}
}
func TestAutolithACPMessageUpdatesAndIsolation(t *testing.T) {
	a:=autolithTestBridge()
	for _,raw:=range []string{
		`{"sessionId":"other","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"not allowed"}}}`,
		`{"sessionId":"one","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hello"}}}`,
		`{"sessionId":"one","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":" world"}}}`,
		`{"sessionId":"one","update":{"sessionUpdate":"tool_call","toolCallId":"tool1","title":"Read","status":"pending"}}`,
		`{"sessionId":"one","update":{"sessionUpdate":"tool_call_update","toolCallId":"tool1","status":"completed"}}`,
	}{
		a.onUpdate(json.RawMessage(raw))
	}
	s:=a.sessions["one"]
	if len(s.Messages)!=1 {t.Fatalf("expected one assistant message, got %d",len(s.Messages))}
	if s.Messages[0].Content[0].Text!="Hello world" {t.Fatalf("unexpected text: %+v",s.Messages)}
	if len(s.Messages[0].Content)!=2 || s.Messages[0].Content[1].State["status"]!="completed" {
		t.Fatalf("tool was not updated in place: %+v",s.Messages[0].Content)
	}
}
func TestAutolithACPAuthorizesAndRepliesOnlyOfferedOptions(t *testing.T) {
	a:=autolithTestBridge()
	e:=echo.New()
	e.GET("/sessions",a.listSessions,a.authorize)
	e.POST("/sessions/:id/permissions/:request/reply",a.reply,a.authorize)

	without:=httptest.NewRequest(http.MethodGet,"/sessions",nil)
	response:=httptest.NewRecorder();e.ServeHTTP(response,without)
	if response.Code!=http.StatusUnauthorized {t.Fatalf("missing key gave %d",response.Code)}

	incoming:=`{"sessionId":"one","toolCall":{"title":"Run command"},"options":[{"optionId":"once","kind":"allow_once"},{"optionId":"deny","kind":"reject_once"},{"optionId":"session","kind":"allow_always"}]}`
	a.onPermission(json.RawMessage("77"),json.RawMessage(incoming))
	var p *autolithPermission
	for _,value:=range a.permissions {p=value}
	if p==nil || p.OnceID!="once" || p.RejectID!="deny" {t.Fatalf("expected explicit options: %+v",p)}
	invalid:=httptest.NewRequest(http.MethodPost,"/sessions/one/permissions/"+p.ID+"/reply",strings.NewReader(`{"decision":"always"}`))
	invalid.Header.Set("X-Kiwi-Agent-Key",a.access);invalid.Header.Set("Content-Type","application/json")
	response=httptest.NewRecorder();e.ServeHTTP(response,invalid)
	if response.Code!=400 {t.Fatalf("permanent approval permitted: %d",response.Code)}
	wrong:=httptest.NewRequest(http.MethodPost,"/sessions/another/permissions/"+p.ID+"/reply",strings.NewReader(`{"decision":"once"}`))
	wrong.Header.Set("X-Kiwi-Agent-Key",a.access);wrong.Header.Set("Content-Type","application/json")
	response=httptest.NewRecorder();e.ServeHTTP(response,wrong)
	if response.Code!=404 {t.Fatalf("permission crossed sessions: %d",response.Code)}
	approved:=httptest.NewRequest(http.MethodPost,"/sessions/one/permissions/"+p.ID+"/reply",strings.NewReader(`{"decision":"once"}`))
	approved.Header.Set("X-Kiwi-Agent-Key",a.access);approved.Header.Set("Content-Type","application/json")
	response=httptest.NewRecorder();e.ServeHTTP(response,approved)
	if response.Code!=204 {t.Fatalf("valid reply failed: %d %s",response.Code,response.Body.String())}
	buf:=a.input.(*autolithBuffer)
	if !strings.Contains(buf.String(),`"optionId":"once"`) || !strings.Contains(buf.String(),`"id":77`) {t.Fatalf("wrong ACP reply: %s",buf.String())}
	if len(a.permissions)!=0 {t.Fatal("permission not consumed")}
}
func TestAutolithACPContextDoesNotWriteFiles(t *testing.T) {
	a:=autolithTestBridge()
	e:=echo.New()
	e.POST("/sessions/:id/messages",a.send,a.authorize)
	invalid:=httptest.NewRequest(http.MethodPost,"/sessions/one/messages",
		strings.NewReader(`{"text":"review","context":{"path":"../secret","space":"x"}}`))
	invalid.Header.Set("X-Kiwi-Agent-Key",a.access);invalid.Header.Set("Content-Type","application/json")
	response:=httptest.NewRecorder();e.ServeHTTP(response,invalid)
	if response.Code!=400 {t.Fatalf("accepted unsafe context: %d",response.Code)}
	if a.sessions["one"].Active || len(a.sessions["one"].Messages)!=0 {t.Fatal("invalid prompt started a turn")}
}
