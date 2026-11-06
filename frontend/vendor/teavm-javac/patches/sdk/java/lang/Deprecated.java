package java.lang;

import java.lang.annotation.*;

@Documented
@Retention(RetentionPolicy.RUNTIME)
public @interface Deprecated {
    String since() default "";

    boolean forRemoval() default false;
}
