import { EvideError, parsePlan } from "./engine.ts";
import type { Domain, Field, Files, Finding, Plan } from "./engine.ts";

export const baseline = { java: "17", boot: "3.5.6", cloud: "2025.0.0", egov: "5.0.0" };
export const className = (s: Domain) => `Egov${s.name[0]?.toUpperCase()}${s.name.slice(1)}`;
export const pkg = (s: Domain) => `gov.egov.generated.${s.name}`;
export const snake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const cap = (name: string) => `${name[0]?.toUpperCase()}${name.slice(1)}`;
export const javaType = (f: Field) => ({ string: "String", long: "Long", decimal: "java.math.BigDecimal", boolean: "Boolean", date: "java.time.LocalDate" })[f.type];
export const sqlType = (f: Field) => ({ string: `VARCHAR(${f.maxLength})`, long: "BIGINT", decimal: "NUMERIC(14,2)", boolean: "BOOLEAN", date: "DATE" })[f.type];
const dep = (artifact: string, group = "org.springframework.boot", extra = "") => `<dependency><groupId>${group}</groupId><artifactId>${artifact}</artifactId>${extra}</dependency>`;
const cloud = (artifact: string) => dep(artifact, "org.springframework.cloud");
const sharedDeps = dep("spring-boot-starter-actuator") + dep("micrometer-registry-prometheus", "io.micrometer") + dep("spring-boot-starter-test", "org.springframework.boot", "<scope>test</scope>");

function pom(module: string, deps: string): string {
  return `<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion><parent><groupId>gov.egov.generated</groupId><artifactId>egov-project</artifactId><version>1.0.0</version></parent>
  <artifactId>${module}</artifactId><dependencies>${deps}${sharedDeps}</dependencies>
  <build><plugins><plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build>
</project>\n`;
}

function docker(module: string): string {
  return `FROM maven:3.9.9-eclipse-temurin-17 AS build
WORKDIR /build
COPY . .
RUN mvn -B -pl ${module} -am package -DskipTests
FROM eclipse-temurin:17-jre
WORKDIR /app
COPY --from=build --chown=10001:10001 /build/${module}/target/app.jar /app/app.jar
USER 10001:10001
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75.0", "-jar", "/app/app.jar"]
`;
}

function constraints(f: Field): string {
  return [
    f.required ? (f.type === "string" ? "@NotBlank" : "@NotNull") : "",
    f.type === "string" ? `@Size(max = ${f.maxLength})` : "",
    f.type === "decimal" ? "@Digits(integer = 12, fraction = 2)" : "",
  ].filter(Boolean).join(" ");
}

function addDomain(files: Files, service: Domain, index: number): void {
  const c = className(service), p = pkg(service), root = `${c}/src/main`, java = `${root}/java/${p.replaceAll(".", "/")}`;
  const fields: { name: string; type: string }[] = [
    { name: "id", type: "Long" }, ...service.fields.map((f) => ({ name: f.name, type: javaType(f) })),
    { name: "frstRegisterId", type: "String" }, { name: "frstRegistPnttm", type: "java.time.Instant" },
    { name: "lastUpdusrId", type: "String" }, { name: "lastUpdtPnttm", type: "java.time.Instant" },
    ...(service.approval ? [{ name: "status", type: "String" }, { name: "approver", type: "String" }, { name: "rejectReason", type: "String" }] : []),
  ];
  files[`${c}/pom.xml`] = pom(c,
    dep("spring-boot-starter-web") + dep("spring-boot-starter-validation") + dep("spring-boot-starter-security") +
    dep("spring-boot-starter-oauth2-resource-server") + cloud("spring-cloud-starter-netflix-eureka-client") +
    cloud("spring-cloud-starter-config") +
    dep("mybatis-spring-boot-starter", "org.mybatis.spring.boot", "<version>3.0.4</version>") +
    dep("egovframe-rte-fdl-cmmn", "org.egovframe.rte", "<version>${egov.version}</version>") +
    dep("egovframe-rte-psl-dataaccess", "org.egovframe.rte", "<version>${egov.version}</version>") +
    dep("jakarta.annotation-api", "jakarta.annotation", "<version>2.1.1</version>") +
    dep("h2", "com.h2database", "<scope>runtime</scope>") +
    dep("postgresql", "org.postgresql", "<scope>runtime</scope>") +
    dep("spring-security-test", "org.springframework.security", "<scope>test</scope>"));
  files[`${java}/${c}Application.java`] = `package ${p};
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.mybatis.spring.annotation.MapperScan;
import org.egovframe.rte.psl.dataaccess.mapper.EgovMapper;
@SpringBootApplication
@MapperScan(basePackages = "${p}", annotationClass = EgovMapper.class)
public class ${c}Application {
    public static void main(String[] args) { SpringApplication.run(${c}Application.class, args); }
}
`;
  files[`${java}/${c}Request.java`] = `package ${p};
import jakarta.validation.constraints.*;
public record ${c}Request(
${service.fields.map((f) => `    ${constraints(f)} ${javaType(f)} ${f.name}`).join(",\n")}
) {}
`;
  files[`${java}/${c}VO.java`] = `package ${p};
public class ${c}VO {
${fields.map((f) => `    private ${f.type} ${f.name};`).join("\n")}
${fields.map((f) => `    public ${f.type} get${cap(f.name)}() { return ${f.name}; }\n    public void set${cap(f.name)}(${f.type} value) { this.${f.name} = value; }`).join("\n")}
}
`;
  files[`${java}/${c}Service.java`] = `package ${p};
import java.util.List;
public interface ${c}Service {
    List<${c}VO> list(int offset, int size, String keyword, String searchCondition);
    ${c}VO get(long id);
    ${c}VO create(${c}Request request, String actor);
    ${c}VO update(long id, ${c}Request request, String actor);
    void remove(long id);
${service.approval ? `    ${c}VO approve(long id, ${c}Approval request, String actor);\n` : ""}}
`;
  files[`${java}/${c}Mapper.java`] = `package ${p};
import java.util.List;
import org.egovframe.rte.psl.dataaccess.mapper.EgovMapper;
import org.apache.ibatis.annotations.Param;
@EgovMapper("${service.name}Mapper")
public interface ${c}Mapper {
    List<${c}VO> selectList(@Param("offset") int offset, @Param("size") int size, @Param("keyword") String keyword, @Param("searchCondition") String searchCondition);
    ${c}VO selectOne(@Param("id") long id);
    int insert(${c}VO row);
    int update(${c}VO row);
    int delete(@Param("id") long id);
${service.approval ? `    int approve(@Param("id") long id, @Param("status") String status, @Param("approver") String approver, @Param("rejectReason") String rejectReason, @Param("now") java.time.Instant now);\n` : ""}}
`;
  const copy = service.fields.map((f) => `        row.set${cap(f.name)}(request.${f.name}());`).join("\n");
  files[`${java}/${c}ServiceImpl.java`] = `package ${p};
import java.util.List;
import java.util.NoSuchElementException;
import java.time.Instant;
import jakarta.annotation.Resource;
import org.egovframe.rte.fdl.cmmn.EgovAbstractServiceImpl;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
@Service
@Transactional
public class ${c}ServiceImpl extends EgovAbstractServiceImpl implements ${c}Service {
    @Resource(name = "${service.name}Mapper")
    private ${c}Mapper mapper;
    @Transactional(readOnly = true)
    public List<${c}VO> list(int offset, int size, String keyword, String searchCondition) {
        return mapper.selectList(offset, size, keyword, searchCondition);
    }
    @Transactional(readOnly = true)
    public ${c}VO get(long id) {
        var row = mapper.selectOne(id);
        if (row == null) throw new NoSuchElementException("Record not found");
        return row;
    }
    public ${c}VO create(${c}Request request, String actor) {
        var row = new ${c}VO();
${copy}
        var now = Instant.now();
        row.setFrstRegisterId(actor); row.setFrstRegistPnttm(now);
        row.setLastUpdusrId(actor); row.setLastUpdtPnttm(now);
${service.approval ? '        row.setStatus("PENDING");\n' : ""}        if (mapper.insert(row) != 1) throw new IllegalStateException("Insert failed");
        return get(row.getId());
    }
    public ${c}VO update(long id, ${c}Request request, String actor) {
        var row = get(id);
${copy}
        row.setLastUpdusrId(actor); row.setLastUpdtPnttm(Instant.now());
        if (mapper.update(row) != 1) throw new IllegalStateException("Record changed or is terminal");
        return get(id);
    }
    public void remove(long id) {
        get(id);
        if (mapper.delete(id) != 1) throw new IllegalStateException("Record changed or is terminal");
    }
${service.approval ? `    public ${c}VO approve(long id, ${c}Approval request, String actor) {
        get(id);
        if (request.decision() == ${c}Approval.Decision.REJECTED && (request.rejectReason() == null || request.rejectReason().isBlank()))
            throw new IllegalArgumentException("Rejection requires a reason");
        String reason = request.decision() == ${c}Approval.Decision.REJECTED ? request.rejectReason() : null;
        if (mapper.approve(id, request.decision().name(), actor, reason, Instant.now()) != 1)
            throw new IllegalStateException("Only a pending record may be approved or rejected");
        return get(id);
    }\n` : ""}}
`;
  if (service.approval) files[`${java}/${c}Approval.java`] = `package ${p};
import jakarta.validation.constraints.*;
public record ${c}Approval(@NotNull Decision decision, @Size(max = 1000) String rejectReason) {
    public enum Decision { APPROVED, REJECTED }
}
`;
  const searches = service.fields.filter((f) => f.type === "string");
  const firstSearch = searches[0]?.name ?? "";
  files[`${java}/${c}Controller.java`] = `package ${p};
import java.util.List;
import java.util.Set;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/api/${service.name}")
@Validated
public class ${c}Controller {
    private final ${c}Service service;
    public ${c}Controller(${c}Service service) { this.service = service; }
    private String actor(Jwt jwt) {
        if (jwt == null || jwt.getSubject() == null || jwt.getSubject().isBlank() || jwt.getSubject().length() > 100)
            throw new AccessDeniedException("A bounded JWT subject is required");
        return jwt.getSubject();
    }
    @GetMapping
    @PreAuthorize("hasAuthority('SCOPE_records.read')")
    public List<${c}VO> list(@RequestParam(defaultValue = "0") @Min(0) @Max(10000) int page,
        @RequestParam(defaultValue = "20") @Min(1) @Max(100) int size,
        @RequestParam(defaultValue = "") @Size(max = 200) String keyword,
        @RequestParam(defaultValue = "${firstSearch}") String searchCondition) {
        if (!Set.of(${searches.map((f) => `"${f.name}"`).join(", ")}).contains(searchCondition))
            throw new IllegalArgumentException("Unknown search column");
        return service.list(page * size, size, keyword, searchCondition);
    }
    @GetMapping("/{id}")
    @PreAuthorize("hasAuthority('SCOPE_records.read')")
    public ${c}VO get(@PathVariable @Positive long id) { return service.get(id); }
    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    @PreAuthorize("hasAuthority('SCOPE_records.write')")
    public ${c}VO create(@Valid @RequestBody ${c}Request request, @AuthenticationPrincipal Jwt jwt) {
        return service.create(request, actor(jwt));
    }
    @PutMapping("/{id}")
    @PreAuthorize("hasAuthority('SCOPE_records.write')")
    public ${c}VO update(@PathVariable @Positive long id, @Valid @RequestBody ${c}Request request, @AuthenticationPrincipal Jwt jwt) {
        return service.update(id, request, actor(jwt));
    }
    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @PreAuthorize("hasAuthority('SCOPE_records.write')")
    public void remove(@PathVariable @Positive long id) { service.remove(id); }
${service.approval ? `    @PatchMapping("/{id}/approval")
    @PreAuthorize("hasAuthority('SCOPE_records.approve')")
    public ${c}VO approve(@PathVariable @Positive long id, @Valid @RequestBody ${c}Approval request, @AuthenticationPrincipal Jwt jwt) {
        return service.approve(id, request, actor(jwt));
    }\n` : ""}}
`;
  files[`${java}/SecurityConfig.java`] = servletSecurity(p);
  // eGov 基类按名称注入 leaveaTrace；仅继承而不注册运行时 bean 会导致应用启动失败。
  files[`${java}/EgovRuntimeConfig.java`] = `package ${p};
import org.springframework.context.MessageSource;
import org.springframework.context.annotation.*;
import org.springframework.context.support.ResourceBundleMessageSource;
import org.egovframe.rte.fdl.cmmn.trace.LeaveaTrace;
import org.egovframe.rte.fdl.cmmn.trace.handler.DefaultTraceHandler;
import org.egovframe.rte.fdl.cmmn.trace.handler.TraceHandler;
import org.egovframe.rte.fdl.cmmn.trace.manager.DefaultTraceHandleManager;
import org.egovframe.rte.fdl.cmmn.trace.manager.TraceHandlerService;
@Configuration
public class EgovRuntimeConfig {
    @Bean
    MessageSource messageSource() {
        var source = new ResourceBundleMessageSource();
        source.setBasename("messages"); source.setDefaultEncoding("UTF-8");
        return source;
    }
    @Bean
    DefaultTraceHandler traceHandler() { return new DefaultTraceHandler(); }
    @Bean
    DefaultTraceHandleManager traceManager(DefaultTraceHandler handler) {
        var manager = new DefaultTraceHandleManager();
        manager.setPatterns(new String[] { "${p}.**" });
        manager.setHandlers(new TraceHandler[] { handler });
        return manager;
    }
    @Bean
    LeaveaTrace leaveaTrace(DefaultTraceHandleManager manager) {
        var trace = new LeaveaTrace();
        trace.setTraceHandlerServices(new TraceHandlerService[] { manager });
        return trace;
    }
}
`;
  files[`${root}/resources/messages.properties`] = "record.not.found=Record not found\nrecord.conflict=Record changed or is terminal\n";
  files[`${java}/ApiErrors.java`] = `package ${p};
import java.util.NoSuchElementException;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
@RestControllerAdvice
public class ApiErrors {
    @ExceptionHandler(NoSuchElementException.class)
    ProblemDetail missing() { return ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, "Record not found"); }
    @ExceptionHandler(IllegalStateException.class)
    ProblemDetail conflict() { return ProblemDetail.forStatusAndDetail(HttpStatus.CONFLICT, "Record changed or is terminal"); }
    @ExceptionHandler(IllegalArgumentException.class)
    ProblemDetail invalid() { return ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, "Invalid request"); }
    @ExceptionHandler(jakarta.validation.ConstraintViolationException.class)
    ProblemDetail constraint() { return ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, "Invalid request parameters"); }
}
`;
  const columns = fields.map((f) => snake(f.name));
  const inserted = fields.filter((f) => f.name !== "id");
  const table = `${service.name}.${service.name}`;
  files[`${root}/resources/mapper/${c}Mapper.xml`] = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "https://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="${p}.${c}Mapper">
  <select id="selectOne" resultType="${p}.${c}VO">
    SELECT ${columns.join(", ")} FROM ${table} WHERE id = #{id}
  </select>
  <select id="selectList" resultType="${p}.${c}VO">
    SELECT ${columns.join(", ")} FROM ${table}
    <where><if test="keyword != null and keyword != ''"><choose>
${searches.map((f) => `      <when test="searchCondition == '${f.name}'">${snake(f.name)} LIKE CONCAT('%', #{keyword}, '%')</when>`).join("\n")}
      <otherwise>1 = 0</otherwise>
    </choose></if></where>
    ORDER BY id DESC LIMIT #{size} OFFSET #{offset}
  </select>
  <insert id="insert" useGeneratedKeys="true" keyProperty="id">
    INSERT INTO ${table} (${inserted.map((f) => snake(f.name)).join(", ")})
    VALUES (${inserted.map((f) => `#{${f.name}}`).join(", ")})
  </insert>
  <update id="update">
    UPDATE ${table} SET ${service.fields.map((f) => `${snake(f.name)} = #{${f.name}}`).join(", ")},
      last_updusr_id = #{lastUpdusrId}, last_updt_pnttm = #{lastUpdtPnttm}
    WHERE id = #{id}${service.approval ? " AND status = 'PENDING'" : ""}
  </update>
  <delete id="delete">DELETE FROM ${table} WHERE id = #{id}${service.approval ? " AND status = 'PENDING'" : ""}</delete>
${service.approval ? `  <update id="approve">
    UPDATE ${table} SET status = #{status}, approver = #{approver}, reject_reason = #{rejectReason},
      last_updusr_id = #{approver}, last_updt_pnttm = #{now}
    WHERE id = #{id} AND status = 'PENDING'
  </update>\n` : ""}</mapper>
`;
  const ddl = `CREATE SCHEMA IF NOT EXISTS ${service.name};
CREATE TABLE IF NOT EXISTS ${table} (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
${service.fields.map((f) => `  ${snake(f.name)} ${sqlType(f)}${f.required ? " NOT NULL" : ""},`).join("\n")}
  frst_register_id VARCHAR(100) NOT NULL,
  frst_regist_pnttm TIMESTAMP WITH TIME ZONE NOT NULL,
  last_updusr_id VARCHAR(100) NOT NULL,
  last_updt_pnttm TIMESTAMP WITH TIME ZONE NOT NULL${service.approval ? ",\n  status VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),\n  approver VARCHAR(100),\n  reject_reason VARCHAR(1000)" : ""}
);
`;
  files[`ddl/${service.name}.sql`] = ddl;
  files[`${root}/resources/schema.sql`] = ddl;
  files[`${root}/resources/application.yml`] = `server:
  port: ${9101 + index}
spring:
  application:
    name: ${c.toUpperCase()}
  datasource:
    url: \${DB_URL:jdbc:h2:mem:${service.name};MODE=PostgreSQL;DB_CLOSE_DELAY=-1}
    username: \${DB_USER:sa}
    password: \${DB_PASSWORD:}
  sql:
    init:
      mode: always
  jackson:
    deserialization:
      fail-on-unknown-properties: true
  security:
    oauth2:
      resourceserver:
        jwt:
          jwk-set-uri: \${JWT_JWK_SET_URI}
mybatis:
  mapper-locations: classpath:mapper/*.xml
  configuration:
    map-underscore-to-camel-case: true
eureka:
  client:
    service-url:
      defaultZone: \${EUREKA_URL:http://localhost:8761/eureka/}
management:
  endpoints:
    web:
      exposure:
        include: health,prometheus
  endpoint:
    health:
      probes:
        enabled: true
      show-details: never
`;
  // cloud 导入放入显式 profile，避免测试禁用 ConfigClient 后仍解析 configserver 地址。
  files[`${root}/resources/application-cloud.yml`] = `spring:
  config:
    import: configserver:\${CONFIG_SERVER_URL:http://localhost:8888}
  datasource:
    url: \${DB_URL}
    username: \${DB_USER}
    password: \${DB_PASSWORD}
`;
  files[`${c}/src/test/java/${p.replaceAll(".", "/")}/${c}Test.java`] = domainTest(service);
}

function servletSecurity(p: string): string {
  return `package ${p};
import org.springframework.context.annotation.*;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;
@Configuration
@EnableMethodSecurity
public class SecurityConfig {
    @Bean
    SecurityFilterChain security(HttpSecurity http) throws Exception {
        return http.csrf(csrf -> csrf.disable())
            .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .authorizeHttpRequests(auth -> auth.requestMatchers("/actuator/health", "/actuator/health/**").permitAll()
                .requestMatchers("/actuator/prometheus").hasAuthority("SCOPE_metrics.read")
                .anyRequest().authenticated())
            .oauth2ResourceServer(resource -> resource.jwt(jwt -> {})).build();
    }
}
`;
}

function domainTest(s: Domain): string {
  const c = className(s), sample = Object.fromEntries(s.fields.map((f) => [f.name, ({ string: "example", long: 1, decimal: 1.25, boolean: true, date: "2026-01-01" })[f.type]]));
  for (const f of s.fields) if (f.type === "string") sample[f.name] = "x".repeat(Math.min(f.maxLength, 7));
  const body = JSON.stringify(JSON.stringify(sample));
  const search = s.fields.find((f) => f.type === "string")!;
  const invalidBody = JSON.stringify(JSON.stringify({ [search.name]: "x".repeat(search.maxLength + 1) }));
  return `package ${pkg(s)};
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
@SpringBootTest(properties = {"spring.cloud.config.enabled=false", "spring.config.import=", "eureka.client.enabled=false", "spring.security.oauth2.resourceserver.jwt.jwk-set-uri=http://localhost/unused"})
@AutoConfigureMockMvc
class ${c}Test {
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;
    private static final String BODY = ${body};
    private org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.JwtRequestPostProcessor scope(String name) {
        return jwt().jwt(token -> token.subject("audited-user")).authorities(new SimpleGrantedAuthority("SCOPE_" + name));
    }
    private long create() throws Exception {
        String response = mvc.perform(post("/api/${s.name}").with(scope("records.write")).contentType("application/json").content(BODY))
            .andExpect(status().isCreated()).andExpect(jsonPath("$.frstRegisterId").value("audited-user"))
            .andExpect(jsonPath("$.frstRegistPnttm").exists()).andExpect(jsonPath("$.lastUpdusrId").value("audited-user"))
            .andExpect(jsonPath("$.lastUpdtPnttm").exists()).andReturn().getResponse().getContentAsString();
        return json.readTree(response).get("id").asLong();
    }
    @Test void accessAndInput() throws Exception {
        mvc.perform(get("/api/${s.name}")).andExpect(status().isUnauthorized());
        mvc.perform(post("/api/${s.name}").with(scope("records.read")).contentType("application/json").content(BODY)).andExpect(status().isForbidden());
        mvc.perform(post("/api/${s.name}").with(scope("records.write")).contentType("application/json").content(${invalidBody})).andExpect(status().isBadRequest());
        mvc.perform(post("/api/${s.name}").with(scope("records.write")).contentType("application/json").content(BODY.substring(0, BODY.length()-1) + ",\\"frstRegisterId\\":\\"spoof\\"}")).andExpect(status().isBadRequest());
        mvc.perform(get("/api/${s.name}").with(scope("records.read")).param("searchCondition", "title; DROP TABLE x")).andExpect(status().isBadRequest());
        mvc.perform(get("/api/${s.name}").with(scope("records.read")).param("size", "101")).andExpect(status().isBadRequest());
    }
    @Test void crud() throws Exception {
        long id = create();
        mvc.perform(get("/api/${s.name}/" + id).with(scope("records.read"))).andExpect(status().isOk());
        mvc.perform(put("/api/${s.name}/" + id).with(scope("records.write")).contentType("application/json").content(BODY)).andExpect(status().isOk());
        mvc.perform(get("/api/${s.name}").with(scope("records.read")).param("keyword", "' OR '1'='1")).andExpect(status().isOk());
        mvc.perform(delete("/api/${s.name}/" + id).with(scope("records.write"))).andExpect(status().isNoContent());
        mvc.perform(get("/api/${s.name}/" + id).with(scope("records.read"))).andExpect(status().isNotFound());
    }
${s.approval ? `    @Test void approvalIsTerminal() throws Exception {
        long id = create();
        mvc.perform(patch("/api/${s.name}/" + id + "/approval").with(scope("records.approve")).contentType("application/json").content("{\\"decision\\":\\"REJECTED\\"}")).andExpect(status().isBadRequest());
        mvc.perform(patch("/api/${s.name}/" + id + "/approval").with(scope("records.approve")).contentType("application/json").content("{\\"decision\\":\\"APPROVED\\"}")).andExpect(status().isOk()).andExpect(jsonPath("$.approver").value("audited-user"));
        mvc.perform(patch("/api/${s.name}/" + id + "/approval").with(scope("records.approve")).contentType("application/json").content("{\\"decision\\":\\"APPROVED\\"}")).andExpect(status().isConflict());
        mvc.perform(put("/api/${s.name}/" + id).with(scope("records.write")).contentType("application/json").content(BODY)).andExpect(status().isConflict());
        mvc.perform(delete("/api/${s.name}/" + id).with(scope("records.write"))).andExpect(status().isConflict());
    }\n` : ""}}
`;
}

function addInfrastructure(files: Files, plan: Plan): void {
  for (const [name, annotation, dependency, port] of [
    ["EurekaServer", "org.springframework.cloud.netflix.eureka.server.EnableEurekaServer", "spring-cloud-starter-netflix-eureka-server", 8761],
    ["ConfigServer", "org.springframework.cloud.config.server.EnableConfigServer", "spring-cloud-config-server", 8888],
  ] as const) {
    const simple = annotation.split(".").at(-1);
    files[`${name}/pom.xml`] = pom(name, cloud(dependency));
    files[`${name}/src/main/java/gov/egov/generated/infra/${name}.java`] = `package gov.egov.generated.infra;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import ${annotation};
@SpringBootApplication
@${simple}
public class ${name} { public static void main(String[] args) { SpringApplication.run(${name}.class, args); } }
`;
    files[`${name}/src/main/resources/application.yml`] = `server:
  port: ${port}
spring:
  application:
    name: ${name}
${name === "ConfigServer" ? "  profiles:\n    active: native\n  cloud:\n    config:\n      server:\n        native:\n          search-locations: classpath:/config/\n" : ""}
${name === "EurekaServer" ? "eureka:\n  client:\n    register-with-eureka: false\n    fetch-registry: false\n" : ""}
management:
  endpoint:
    health:
      probes:
        enabled: true
      show-details: never
  endpoints:
    web:
      exposure:
        include: health
`;
  }
  files["ConfigServer/src/main/resources/config/application.yml"] = `management:
  endpoint:
    health:
      probes:
        enabled: true
      show-details: never
logging:
  level:
    root: INFO
`;
  files["GatewayServer/pom.xml"] = pom("GatewayServer", cloud("spring-cloud-starter-gateway-server-webflux") +
    cloud("spring-cloud-starter-netflix-eureka-client") + cloud("spring-cloud-starter-config") +
    cloud("spring-cloud-starter-loadbalancer") + dep("spring-boot-starter-oauth2-resource-server"));
  files["GatewayServer/src/main/java/gov/egov/generated/gateway/GatewayServer.java"] = `package gov.egov.generated.gateway;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
@SpringBootApplication
public class GatewayServer { public static void main(String[] args) { SpringApplication.run(GatewayServer.class, args); } }
`;
  files["GatewayServer/src/main/java/gov/egov/generated/gateway/SecurityConfig.java"] = `package gov.egov.generated.gateway;
import org.springframework.context.annotation.*;
import org.springframework.security.config.web.server.ServerHttpSecurity;
import org.springframework.security.web.server.SecurityWebFilterChain;
import org.springframework.http.HttpMethod;
@Configuration
public class SecurityConfig {
    @Bean
    SecurityWebFilterChain security(ServerHttpSecurity http) {
        return http.csrf(csrf -> csrf.disable()).authorizeExchange(auth -> auth
            .pathMatchers(HttpMethod.OPTIONS, "/api/**").permitAll()
            .pathMatchers("/actuator/health", "/actuator/health/**").permitAll()
            .pathMatchers("/actuator/prometheus").hasAuthority("SCOPE_metrics.read")
            .anyExchange().authenticated()).oauth2ResourceServer(resource -> resource.jwt(jwt -> {})).build();
    }
}
`;
  files["GatewayServer/src/main/resources/application.yml"] = `server:
  port: 9000
spring:
  application:
    name: GatewayServer
  security:
    oauth2:
      resourceserver:
        jwt:
          jwk-set-uri: \${JWT_JWK_SET_URI}
  cloud:
    gateway:
      server:
        webflux:
          globalcors:
            cors-configurations:
              '[/**]':
                allowedOrigins: \${CORS_ALLOWED_ORIGIN:http://localhost:4545}
                allowedMethods: [GET, POST, PUT, PATCH, DELETE, OPTIONS]
                allowedHeaders: [Authorization, Content-Type]
                allowCredentials: false
          routes:
${plan.services.map((s) => `            - id: ${s.name}\n              uri: lb://${className(s).toUpperCase()}\n              predicates:\n                - Path=/api/${s.name},/api/${s.name}/**`).join("\n")}
eureka:
  client:
    service-url:
      defaultZone: \${EUREKA_URL:http://localhost:8761/eureka/}
management:
  endpoint:
    health:
      probes:
        enabled: true
      show-details: never
  endpoints:
    web:
      exposure:
        include: health,prometheus
`;
  files["GatewayServer/src/main/resources/application-cloud.yml"] = `spring:
  config:
    import: configserver:\${CONFIG_SERVER_URL:http://localhost:8888}
`;
}

function addDeployment(files: Files, plan: Plan, modules: string[]): void {
  const ports = [8761, 8888, 9000, ...plan.services.map((_, i) => 9101 + i)];
  let compose = "services:\n";
  for (const [index, module] of modules.entries()) {
    const domain = plan.services[index - 3], name = module.toLowerCase(), port = ports[index];
    files[`${module}/Dockerfile`] = docker(module);
    compose += `  ${name}:\n    build:\n      context: .\n      dockerfile: ${module}/Dockerfile\n${module === "GatewayServer" ? `    ports: ["9000:9000"]\n` : ""}    environment:\n      CONFIG_SERVER_URL: http://configserver:8888\n      EUREKA_URL: http://eurekaserver:8761/eureka/\n${index >= 2 ? "      SPRING_PROFILES_ACTIVE: cloud\n      JWT_JWK_SET_URI: ${JWT_JWK_SET_URI:?Set a reachable JWT JWK set URI}\n" : ""}${domain ? `      DB_URL: jdbc:postgresql://${domain.name}-db:5432/${domain.name}\n      DB_USER: \${${domain.name.toUpperCase()}_DB_USER:?Set database user}\n      DB_PASSWORD: \${${domain.name.toUpperCase()}_DB_PASSWORD:?Set database password}\n` : ""}${index >= 2 ? "    depends_on:\n      configserver:\n        condition: service_started\n      eurekaserver:\n        condition: service_started\n" : ""}${domain ? `      ${domain.name}-db:\n        condition: service_healthy\n` : ""}    restart: on-failure\n`;
    files[`deploy/k8s/${name}.yml`] = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
spec:
  replicas: 1
  selector:
    matchLabels: {app: ${name}}
  template:
    metadata:
      labels: {app: ${name}}
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
        runAsGroup: 10001
        fsGroup: 10001
      containers:
        - name: app
          image: \${REGISTRY}/${name}:1.0.0
          ports: [{containerPort: ${port}}]
          env:
            - {name: CONFIG_SERVER_URL, value: "http://configserver:8888"}
            - {name: EUREKA_URL, value: "http://eurekaserver:8761/eureka/"}
${index >= 2 ? '            - {name: SPRING_PROFILES_ACTIVE, value: cloud}\n            - name: JWT_JWK_SET_URI\n              valueFrom:\n                configMapKeyRef: {name: egov-runtime, key: jwt-jwk-set-uri}\n' : ""}${domain ? `            - name: DB_URL\n              valueFrom:\n                secretKeyRef: {name: ${domain.name}-db, key: url}\n            - name: DB_USER\n              valueFrom:\n                secretKeyRef: {name: ${domain.name}-db, key: username}\n            - name: DB_PASSWORD\n              valueFrom:\n                secretKeyRef: {name: ${domain.name}-db, key: password}\n` : ""}          startupProbe:
            httpGet: {path: /actuator/health/liveness, port: ${port}}
            failureThreshold: 60
            periodSeconds: 5
          readinessProbe:
            httpGet: {path: /actuator/health/readiness, port: ${port}}
          livenessProbe:
            httpGet: {path: /actuator/health/liveness, port: ${port}}
          resources:
            requests: {cpu: 100m, memory: 256Mi}
            limits: {cpu: "1", memory: 768Mi}
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: {drop: ["ALL"]}
          volumeMounts: [{name: tmp, mountPath: /tmp}]
      volumes: [{name: tmp, emptyDir: {}}]
---
apiVersion: v1
kind: Service
metadata:
  name: ${name}
spec:
  selector: {app: ${name}}
  ports: [{port: ${port}, targetPort: ${port}}]
`;
  }
  for (const s of plan.services) compose += `  ${s.name}-db:
    image: postgres:17
    environment:
      POSTGRES_DB: ${s.name}
      POSTGRES_USER: \${${s.name.toUpperCase()}_DB_USER:?Set database user}
      POSTGRES_PASSWORD: \${${s.name.toUpperCase()}_DB_PASSWORD:?Set database password}
    volumes: [${s.name}-data:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $$POSTGRES_USER -d $$POSTGRES_DB"]
      interval: 5s
      retries: 12
`;
  compose += `volumes:\n${plan.services.map((s) => `  ${s.name}-data: {}`).join("\n")}\n`;
  files["compose.yml"] = compose;
  files["deploy/k8s/network-policy.yml"] = `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: egov-internal
spec:
  podSelector: {}
  policyTypes: [Ingress]
  ingress:
    - from: [{podSelector: {}}]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: egov-gateway
spec:
  podSelector:
    matchLabels: {app: gatewayserver}
  policyTypes: [Ingress]
  ingress:
    - ports: [{port: 9000, protocol: TCP}]
`;
}

const md = (s: string) => s.replace(/[|<>`]/g, " ").replace(/[\r\n]+/g, " ");
function addPmo(files: Files, plan: Plan): void {
  const assumptions = plan.assumptions.map((s) => `* ${md(s)}`).join("\n");
  const rows = plan.services.map((s, i) => `| REQ-${String(i + 1).padStart(3, "0")} | ${md(s.label)} CRUD${s.approval ? " + 승인/반려" : ""} | ${className(s)} | TC-${i + 1} |`).join("\n");
  files["docs/pmo/01-requirements.md"] = `# 요구사항 정의서 — ${md(plan.title)}
\n${md(plan.summary)}\n\n상태: 자동 작성 초안. 발주기관 요구사항 대조와 승인 필요.\n\n| ID | 기능 | 서비스 | 검증 |\n|---|---|---|---|\n${rows}
\n## 비기능 요구사항\n* NFR-001: JWT scope 인가와 서버 소유 감사 필드.\n* NFR-002: 파라미터 바인딩, 입력 길이 제한, 서비스별 독립 스키마.\n* NFR-003: 헬스 프로브, 비루트 컨테이너, CPU/메모리 제한.\n\n## 해석 가정\n${assumptions}\n\n지원 범위: 서비스별 단일 엔터티. 추가 통합·파일·관계 모델은 별도 설계가 필요하다.\n`;
  files["docs/pmo/02-architecture.md"] = `# 아키텍처 정의서
\n기준: Java ${baseline.java}, Spring Boot ${baseline.boot}, Spring Cloud ${baseline.cloud}, eGovFrame ${baseline.egov}.
\n| 모듈 | 포트 | 역할 |\n|---|---|---|\n| EurekaServer | 8761 | 디스커버리 |\n| ConfigServer | 8888 | 비밀이 아닌 중앙 설정 |\n| GatewayServer | 9000 | JWT 검증·라우팅 |\n${plan.services.map((s, i) => `| ${className(s)} | ${9101 + i} | ${md(s.label)}; ${s.name}.${s.name} 독립 DB 스키마 |`).join("\n")}
\n\`\`\`mermaid\nflowchart LR\n  Client --> Gateway\n  Gateway --> Eureka\n  Gateway --> Config\n${plan.services.map((s) => `  Gateway --> ${className(s)}\n  ${className(s)} --> ${s.name}DB`).join("\n")}\n\`\`\`
\n다이어그램 IR: diagrams/*.json. 소스 근거: diagrams/source-analysis.json.
\n로컬은 서비스별 H2, Compose는 서비스별 PostgreSQL 컨테이너다. 서비스 간 물리 FK는 없다.
Config/Eureka는 내부망 전용이다. 기관 IdP, 감사 보관 기간, 백업 및 외부 TLS는 배포 설계에서 확정해야 한다.
Jakarta API를 사용하는 Spring 애플리케이션이며 Jakarta EE 서버 전체 인증을 뜻하지 않는다.\n`;
  files["docs/pmo/03-interfaces.md"] = `# 인터페이스 정의서
\nGateway: http://localhost:9000. Authorization: Bearer JWT. 역할(scope): records.read/write/approve.
요청은 선언된 필드만 허용하며 id·감사 필드·승인자는 서버 소유다.
\n${plan.services.map((s) => `## ${md(s.label)}\n라우팅: lb://${className(s).toUpperCase()}\n\n| API ID | Method | URI | 권한 |\n|---|---|---|---|\n${[["LIST", "GET", "", "read"], ["GET", "GET", "/{id}", "read"], ["CREATE", "POST", "", "write"], ["UPDATE", "PUT", "/{id}", "write"], ["DELETE", "DELETE", "/{id}", "write"], ...(s.approval ? [["APPROVAL", "PATCH", "/{id}/approval", "approve"]] : [])].map(([id, method, suffix, scope]) => `| API-${s.name}-${id} | ${method} | /api/${s.name}${suffix} | records.${scope} |`).join("\n")}
\n| 요청 필드 | Java 타입 | 필수 | 최대 문자열 길이 |\n|---|---|---|---|\n${s.fields.map((f) => `| ${f.name} | ${javaType(f)} | ${f.required} | ${f.type === "string" ? f.maxLength : "-"} |`).join("\n")}
\n응답: id, 요청 필드, frstRegisterId/frstRegistPnttm/lastUpdusrId/lastUpdtPnttm${s.approval ? ", status/approver/rejectReason" : ""}.
목록: page=0..10000, size=1..100, keyword 최대 200자, searchCondition 화이트리스트.
${s.approval ? '승인 요청: {"decision":"APPROVED"|"REJECTED","rejectReason":"최대 1000자; 반려 시 필수"}. PENDING에서만 변경하며 완료 후 수정·삭제는 409.' : ""}
오류: 400 입력, 401 인증, 403 권한, 404 없음, 409 상태 충돌.\n`).join("\n")}`;
  const points = plan.services.reduce((n, s) => n + 5 * 4 + (s.approval ? 4 : 0), 0);
  files["docs/pmo/04-wbs.md"] = `# WBS 및 일정 계획서
\n추정 모델: CRUD 5개 × 가중치 4 + 승인 기능 가중치 4 = ${points} 유사 기능점수.
이는 간이 추정치이며 공식 IFPUG FP 산정·계약 공수로 사용할 수 없다.
생산성 가정 5점/인일이면 ${Math.ceil(points / 5)}인일 + 검토·통합 여유가 필요하다.
\n| 마일스톤 | 상대 일정 | 작업 | 완료 조건 |\n|---|---|---|---|\n| M1 | 1주 | 요구사항·가정 검토 | REQ 승인 |\n| M2 | 2주 | 아키텍처·인터페이스 | 설계 승인 |\n| M3 | 3주 | 코드·DDL 검토 | Maven 빌드 |\n| M4 | 4주 | 기관 IdP·DB·클라우드 연결 | 통합 테스트 |\n| M5 | 5주 | 보안·성능·장애 시험 | 결함 조치 |\n| M6 | 6주 | 감리·이행·운영 인계 | 기관 승인 |\n\n일정은 기준일 미지정 초안이며 실제 인력·규모로 재산정해야 한다.\n`;
  files["docs/pmo/05-quality-tests.md"] = `# 품질 및 시험 계획서
\n자동 생성은 공인 적합성·보안 인증이 아니다. docs/validation.json은 한정된 정적 규칙 결과다.
\n| ID | 대상 | 자동화 |\n|---|---|---|\n${plan.services.map((s, i) => `| TC-${i + 1} | ${md(s.label)} CRUD, 미인증/권한 오류, 감사 필드 위조, 검색 SQL 입력${s.approval ? ", 중복 승인·반려 사유·완료 후 수정" : ""} | ${className(s)}Test.java |`).join("\n")}
\n실행: Java 17 + Maven 3.9 이상에서 \`mvn test\`. 생성 당시 이 테스트를 실행한 것으로 간주하면 안 된다.
\n## 시큐어코딩 대응 및 잔여 심사\n* SQL 삽입: MyBatis #{} 바인딩, 검색 컬럼 choose 화이트리스트. XML 정적 검사.\n* 입력 검증: Jakarta Validation; 알 수 없는 JSON 필드 거부. 길이 제한은 버퍼 오버플로 전체 방어 인증이 아니다.\n* 접근 제어: JWT 서명 검증·scope. 기관별 객체 소유권/tenant 권한은 별도 구현 및 심사 필요.\n* 감사: 등록/수정자 JWT subject 및 서버 시각; 독립 감사 로그, 보관/위변조 방지는 별도 운영 통제.\n* 컨테이너: UID 10001, 비밀 환경변수/Secret 참조, 자원 제한·프로브.\n* 필수 수동 항목: 행안부/기관 채택 규칙 전수 매핑, 의존성 CVE/SBOM, 침투시험, 부하/장애/복구 시험, 개인정보 영향평가, TLS·키 순환·로그 마스킹.\n* eGovFrame 클라우드 개발자 가이드의 배포 환경·버전별 체크리스트를 발주기관과 대조해야 한다.\n\n판정: 자동 검사 범위 내 결과와 수동 검토 대기를 구분한다. 미실행 검증은 통과가 아니다.\n`;
}

export function validateFiles(files: Files): Finding[] {
  const findings: Finding[] = [];
  for (const [path, content] of Object.entries(files)) {
    if (path.endsWith(".java") && /\bjavax\./.test(content)) findings.push({ severity: "ERROR", code: "LEGACY_JAVAX", file: path, message: "Legacy javax namespace emitted." });
    if (path.endsWith("Mapper.xml") && /\$\{/.test(content)) findings.push({ severity: "ERROR", code: "SQL_SUBSTITUTION", file: path, message: "MyBatis raw substitution is forbidden." });
    if (path.endsWith("ServiceImpl.java") && !content.includes("extends EgovAbstractServiceImpl")) findings.push({ severity: "ERROR", code: "EGOV_SERVICE", file: path, message: "Missing eGov service base." });
    if (path.endsWith("Mapper.java") && !content.includes("@EgovMapper(")) findings.push({ severity: "ERROR", code: "EGOV_MAPPER", file: path, message: "Missing eGovFrame 5 mapper annotation." });
    if (path.endsWith("/Dockerfile") && !content.includes("USER 10001:10001")) findings.push({ severity: "ERROR", code: "ROOT_CONTAINER", file: path, message: "Non-root runtime is required." });
  }
  findings.push({ severity: "WARN", code: "REVIEW_REQUIRED", message: "Static checks are not eGovFrame/Jakarta certification or exhaustive MOIS secure-coding review. Maven, deployment and agency security acceptance remain required." });
  return findings;
}

export function generateProject(input: Plan): { files: Files; findings: Finding[] } {
  const plan = parsePlan(input), files: Files = {};
  const modules = ["EurekaServer", "ConfigServer", "GatewayServer", ...plan.services.map(className)];
  files["pom.xml"] = `<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>${baseline.boot}</version><relativePath/></parent>
  <groupId>gov.egov.generated</groupId><artifactId>egov-project</artifactId><version>1.0.0</version><packaging>pom</packaging>
  <properties><java.version>${baseline.java}</java.version><egov.version>${baseline.egov}</egov.version><spring-cloud.version>${baseline.cloud}</spring-cloud.version><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding></properties>
  <modules>${modules.map((m) => `<module>${m}</module>`).join("")}</modules>
  <repositories><repository><id>egovframe</id><url>https://maven.egovframe.go.kr/maven/</url><releases><enabled>true</enabled></releases><snapshots><enabled>false</enabled></snapshots></repository></repositories>
  <dependencyManagement><dependencies>${dep("spring-cloud-dependencies", "org.springframework.cloud", "<version>${spring-cloud.version}</version><type>pom</type><scope>import</scope>")}</dependencies></dependencyManagement>
  <build><finalName>app</finalName><plugins><plugin>
    <groupId>org.apache.maven.plugins</groupId><artifactId>maven-antrun-plugin</artifactId><version>3.1.0</version>
    <executions><execution><id>validate-generated-sources</id><phase>validate</phase><goals><goal>run</goal></goals>
      <configuration><target>
        <resourcecount property="evide.unsafe.count"><union>
          <fileset dir="\${project.basedir}" includes="**/*.java" excludes="**/target/**"><containsregexp expression="javax[.]"/></fileset>
          <fileset dir="\${project.basedir}" includes="**/*Mapper.xml" excludes="**/target/**"><containsregexp expression="[$][{]"/></fileset>
        </union></resourcecount>
        <fail message="Evide validation failed: legacy javax namespace or raw MyBatis substitution."><condition><not><equals arg1="\${evide.unsafe.count}" arg2="0"/></not></condition></fail>
      </target></configuration>
    </execution></executions>
  </plugin></plugins></build>
</project>
`;
  plan.services.forEach((s, i) => addDomain(files, s, i));
  addInfrastructure(files, plan);
  addDeployment(files, plan, modules);
  addPmo(files, plan);
  files["design.json"] = JSON.stringify(plan, null, 2);
  files[".gitignore"] = "target/\n.env\n*.log\n.evide-local/\n";
  files[".dockerignore"] = "**/target\n.git\n.env\ndiagrams/*.html\n";
  files["README.md"] = `# ${md(plan.title)}
\n${md(plan.summary)}
\n## Build and test\nJava 17 and Maven 3.9+: \`mvn test\`, then \`mvn package\`.
Start ConfigServer (8888), EurekaServer (8761), domain services, GatewayServer (9000), in that order.
Set JWT_JWK_SET_URI to a reachable IdP JWK set. API tokens need records.read/write/approve scopes.
For local H2, run module JARs; for PostgreSQL, set DB_URL, DB_USER and DB_PASSWORD.
The cloud profile enables mandatory Config Server import and requires explicit database credentials.
Compose needs JWT_JWK_SET_URI and each DOMAIN_DB_USER / DOMAIN_DB_PASSWORD. Run \`docker compose up --build\`.
Config/Eureka are internal-only; Compose only publishes Gateway. Scope claims must be issued by the trusted IdP.
\n## Kubernetes\nSet REGISTRY in manifests through your deployment pipeline; provision egov-runtime ConfigMap and
per-domain DB Secrets (url, username, password). Databases and IdP are external dependencies.
Apply in an isolated namespace with NetworkPolicy-capable CNI. Gateway ingress TLS and external
registry access are deployment-specific. No credentials are generated.
\n## Review\nRead docs/pmo, docs/validation.json and diagrams/source-analysis.json.
These are drafts and bounded static checks, NOT a certification. LLM interpretation must be reviewed.
Generated tests are source files; only an actual Maven run establishes their outcome.\n`;
  const findings = validateFiles(files);
  if (findings.some((f) => f.severity === "ERROR")) throw new EvideError("Generated source failed validation; output blocked.", 422);
  files["docs/validation.json"] = JSON.stringify({ scope: "bounded-static-rules", certification: false, javaTests: "NOT_RUN", findings }, null, 2);
  return { files, findings };
}
